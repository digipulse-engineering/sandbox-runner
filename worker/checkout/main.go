package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	gitclient "github.com/go-git/go-git/v5/plumbing/transport/client"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
)

const (
	githubHost = "github.harness.internal"
	workspace  = "/workspace"
	caFile     = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
)

var ownerPattern = regexp.MustCompile("^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")
var namePattern = regexp.MustCompile("^[A-Za-z0-9._-]+$")
var shaPattern = regexp.MustCompile("^[a-f0-9]{40}$")

func validSlug(slug string) bool {
	owner, name, ok := strings.Cut(slug, "/")
	return ok && ownerPattern.MatchString(owner) && namePattern.MatchString(name) &&
		name != "." && name != ".." && !strings.HasSuffix(strings.ToLower(name), ".git")
}

type readTransport struct {
	base http.RoundTripper
	path string
}

func (t readTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	url := req.URL
	discover := req.Method == http.MethodGet && url.EscapedPath() == t.path+"/info/refs" &&
		url.RawQuery == "service=git-upload-pack"
	upload := req.Method == http.MethodPost && url.EscapedPath() == t.path+"/git-upload-pack" && url.RawQuery == ""
	if url.Scheme != "https" || url.Host != githubHost || url.User != nil || (!discover && !upload) ||
		req.Header.Get("Authorization") != "" || req.Header.Get("Proxy-Authorization") != "" {
		return nil, errors.New("Git read route denied")
	}
	return t.base.RoundTrip(req)
}

func installReadTransport(slug string, ca []byte) error {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return errors.New("Git interception CA invalid")
	}
	base := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	gitclient.InstallProtocol("https", githttp.NewClient(&http.Client{
		Transport: readTransport{base: base, path: "/" + slug + ".git"},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("Git redirect denied")
		},
	}))
	return nil
}

func fetchShallow(ctx context.Context, path, sha, cert string) error {
	if !shaPattern.MatchString(sha) {
		return errors.New("invalid shallow checkout SHA")
	}
	// This repository was just initialized by the helper, with an exact origin
	// set by the caller. A bounded fetch runs before writing the checkout tree.
	command := exec.CommandContext(ctx, "/usr/bin/git",
		"-c", "protocol.version=2", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
		"-c", "http.followRedirects=false", "-c", "http.sslVerify=true", "-c", "http.sslCAInfo="+cert, "-c", "credential.helper=",
		"-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
		"fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", sha+":refs/sandbox-runner/base",
	)
	command.Dir = path
	command.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
	return command.Run()
}

func verifyShallowBoundary(path, sha string, hasParent bool) error {
	data, err := os.ReadFile(filepath.Join(path, ".git", "shallow"))
	if errors.Is(err, os.ErrNotExist) && !hasParent {
		return nil
	}
	if err != nil || string(data) != sha+"\n" {
		return errors.New("Git shallow boundary mismatch")
	}
	return nil
}

func checkout(ctx context.Context, path, slug, sha string, shallow bool) error {
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		return errors.New("workspace is not empty or accessible")
	}
	repo, err := git.PlainInit(path, false)
	if err != nil {
		return err
	}
	remote, err := repo.CreateRemote(&config.RemoteConfig{
		Name: "origin",
		URLs: []string{"https://" + githubHost + "/" + slug + ".git"},
	})
	if err != nil {
		return err
	}
	if shallow {
		if err = fetchShallow(ctx, path, sha, caFile); err != nil {
			return err
		}
		// Native Git wrote the shallow object pack outside go-git's storage.
		// Reopen it before looking up or materializing the commit.
		if repo, err = git.PlainOpen(path); err != nil {
			return err
		}
	} else {
		opts := &git.FetchOptions{
			RefSpecs: []config.RefSpec{config.RefSpec(sha + ":refs/sandbox-runner/base")},
			Tags:     git.NoTags,
		}
		if err = remote.FetchContext(ctx, opts); errors.Is(err, git.ErrExactSHA1NotSupported) {
			// The same authorized remote and deadline apply when an older server
			// lacks the exact-object capability. The checkout below still uses sha.
			opts.RefSpecs = []config.RefSpec{"refs/heads/*:refs/remotes/origin/*"}
			err = remote.FetchContext(ctx, opts)
		}
		if err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	hash := plumbing.NewHash(sha)
	commit, err := repo.CommitObject(hash)
	if err != nil {
		return err
	}
	if shallow {
		if err = verifyShallowBoundary(path, sha, len(commit.ParentHashes) > 0); err != nil {
			return err
		}
	}
	tree, err := repo.Worktree()
	if err != nil {
		return err
	}
	// Worktree.Checkout does not recurse into submodules or invoke Git CLI
	// hooks or filters. It operates on the fetched object within this process.
	if err = tree.Checkout(&git.CheckoutOptions{Hash: hash}); err != nil {
		return err
	}
	head, err := repo.Head()
	if err != nil || head.Hash() != hash {
		return errors.New("Git checkout HEAD mismatch")
	}
	return ctx.Err()
}

func run(args []string) (string, error) {
	flags := flag.NewFlagSet("sandbox-runner-checkout", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	slug := flags.String("repo", "", "")
	sha := flags.String("sha", "", "")
	shallow := flags.Bool("shallow", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || !validSlug(*slug) || !shaPattern.MatchString(*sha) {
		return "", errors.New("invalid checkout request")
	}
	timeout, err := strconv.ParseInt(os.Getenv("SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS"), 10, 32)
	if err != nil || timeout <= 0 {
		return "", errors.New("invalid checkout timeout")
	}
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return "", err
	}
	if !*shallow {
		if err = installReadTransport(*slug, ca); err != nil {
			return "", err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	if err = checkout(ctx, workspace, *slug, *sha, *shallow); err != nil {
		return "", err
	}
	return *sha, nil
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "snapshot" || os.Args[1] == "export" || os.Args[1] == "agent" ||
		os.Args[1] == "supervise-codex") {
		if err := runPublicationCommand(os.Args[1:]); err != nil {
			var exit supervisedExit
			if errors.As(err, &exit) {
				os.Exit(int(exit))
			}
			// A partial stream is unusable. Consumers require exit 0 and a
			// matching final digest before touching GitHub.
			fmt.Fprintln(os.Stderr, publicationErrorCode(err))
			os.Exit(1)
		}
		return
	}
	sha, err := run(os.Args[1:])
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": "github_checkout_failed"})
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(struct {
		SHA      string `json:"sha"`
		Checkout bool   `json:"checkout"`
	}{sha, true})
}
