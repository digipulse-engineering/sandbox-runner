package main

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
)

func TestWorkspaceAlreadyStartedIsNeverReplaced(t *testing.T) {
	path := t.TempDir()
	witness := filepath.Join(path, "already-started.txt")
	if err := os.WriteFile(witness, []byte("keep my changes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkout(context.Background(), path, "fixture/private", "0123456789abcdef0123456789abcdef01234567", false); err == nil {
		t.Fatal("checkout accepted a nonempty workspace")
	}
	data, err := os.ReadFile(witness)
	if err != nil || string(data) != "keep my changes" {
		t.Fatal("checkout changed the existing workspace")
	}
}

func TestReadTransportRejectsOtherHostsWritesAndCredentials(t *testing.T) {
	root := "https://" + githubHost + "/fixture/private.git"
	for _, tc := range []struct{ method, url, auth string }{
		{"GET", "https://unapproved.invalid/fixture/private.git/info/refs?service=git-upload-pack", ""},
		{"POST", root + "/git-receive-pack", ""},
		{"POST", root + "/git-upload-pack?extra=true", ""},
		{"GET", root + "/info/refs?service=git-upload-pack", "synthetic"},
	} {
		request, err := http.NewRequest(tc.method, tc.url, nil)
		if err != nil {
			t.Fatal(err)
		}
		if tc.auth != "" {
			request.Header.Set("Authorization", tc.auth)
		}
		transport := readTransport{path: "/fixture/private.git"}
		if _, err := transport.RoundTrip(request); err == nil {
			t.Fatal("request crossed the read-only route")
		}
	}
	for _, slug := range []string{"fixture/private.git", "fixture/..", "fixture/other/repo", "fixturK/private"} {
		if validSlug(slug) {
			t.Fatal("accepted unsafe slug")
		}
	}
}

func TestShallowFetchUsesTheExactCommitAndNoParent(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "source")
	env := []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid",
		"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid"}
	runGit := func(args ...string) string {
		t.Helper()
		command := exec.Command("/usr/bin/git", args...)
		command.Dir, command.Env = root, env
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %q: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	runGit("init", "--object-format=sha1", remote)
	commit := func(text string) string {
		t.Helper()
		if err := os.WriteFile(filepath.Join(remote, "witness"), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		runGit("-C", remote, "add", "witness")
		runGit("-C", remote, "commit", "-m", text)
		return runGit("-C", remote, "rev-parse", "HEAD")
	}
	parent, selected := commit("parent"), commit("selected")
	commit("tip")
	runGit("clone", "--bare", remote, filepath.Join(root, "fixture.git"))
	runGit("-C", filepath.Join(root, "fixture.git"), "config", "uploadpack.allowReachableSHA1InWant", "true")

	backend := filepath.Join(runGit("--exec-path"), "git-http-backend")
	server := httptest.NewTLSServer(&cgi.Handler{Path: backend, Dir: root, Env: []string{
		"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1",
	}})
	defer server.Close()
	cert := filepath.Join(root, "ca.pem")
	if err := os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "checkout")
	repo, err := git.PlainInit(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repo.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{server.URL + "/fixture.git"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = fetchShallow(ctx, path, selected, cert); err != nil {
		t.Fatal(err)
	}
	if err = verifyShallowBoundary(path, selected, true); err != nil {
		t.Fatal(err)
	}
	repo, err = git.PlainOpen(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repo.CommitObject(plumbing.NewHash(parent)); err == nil {
		t.Fatal("shallow fetch downloaded the parent")
	}
	tree, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	if err = tree.Checkout(&git.CheckoutOptions{Hash: plumbing.NewHash(selected)}); err != nil {
		t.Fatal(err)
	}
	head, err := repo.Head()
	if err != nil || head.Hash().String() != selected {
		t.Fatalf("HEAD did not select the exact commit: %v", err)
	}
	witness, err := os.ReadFile(filepath.Join(path, "witness"))
	if err != nil || string(witness) != "selected" {
		t.Fatalf("incorrect checkout: %q: %v", witness, err)
	}
}
