package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"slices"
	"sort"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/go-git/go-git/v5/plumbing/object"
	"golang.org/x/text/unicode/norm"
)

var (
	errPublicationLimit      = errors.New("github_publication_limit_exceeded")
	errUnsafeWorkspace       = errors.New("github_publication_unsafe_workspace")
	errInvalidBaseline       = errors.New("github_publication_baseline_invalid")
	errWorkspaceBusy         = errors.New("github_publication_workspace_busy")
	errSupervisorUnverified  = errors.New("github_publication_supervisor_unverified")
	errSupervisorTimeout     = errors.New("github_publication_supervisor_timeout")
	errSupervisorInterrupted = errors.New("github_publication_supervisor_interrupted")
)

type supervisedExit int

func (supervisedExit) Error() string { return "supervised Codex process exited" }

func publicationErrorCode(err error) string {
	for _, known := range []error{errPublicationLimit, errUnsafeWorkspace, errInvalidBaseline, errWorkspaceBusy,
		errSupervisorUnverified, errSupervisorTimeout, errSupervisorInterrupted} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return "github_publication_export_failed"
}

func statusFields(status []byte, field string) []string {
	var values []string
	for line := range strings.SplitSeq(string(status), "\n") {
		if tail, found := strings.CutPrefix(line, field); found {
			values = strings.Fields(tail)
		}
	}
	return values
}

func terminatedThreadGroup(state string, status []byte) bool {
	// The thread-group leader can be a zombie while sibling threads are
	// still running. Only a lone zombie has no thread that can modify files.
	threads := statusFields(status, "Threads:")
	return state == "Z" && len(threads) == 1 && threads[0] == "1"
}

type baselineEntry struct {
	Name     string            `json:"name"`
	Mode     filemode.FileMode `json:"mode"`
	SHA      string            `json:"sha"`
	Children []baselineEntry   `json:"children,omitempty"`
}

type publicationBaseline struct {
	BaseSHA string        `json:"baseSha"`
	Tree    baselineEntry `json:"tree"`
}

func gitTreeHash(entries []object.TreeEntry) (plumbing.Hash, error) {
	sort.Sort(object.TreeEntrySorter(entries))
	tree := object.Tree{Entries: entries}
	var encoded plumbing.MemoryObject
	if err := tree.Encode(&encoded); err != nil {
		return plumbing.ZeroHash, err
	}
	return encoded.Hash(), nil
}

func snapshotBaseline(repo *git.Repository, sha string) (publicationBaseline, error) {
	head, err := repo.Head()
	if err != nil || head.Hash().String() != sha {
		return publicationBaseline{}, errInvalidBaseline
	}
	commit, err := repo.CommitObject(head.Hash())
	if err != nil {
		return publicationBaseline{}, errInvalidBaseline
	}
	tree, err := snapshotTree(repo, "", commit.TreeHash)
	if err != nil {
		return publicationBaseline{}, err
	}
	return publicationBaseline{BaseSHA: sha, Tree: tree}, nil
}

func snapshotTree(repo *git.Repository, name string, sha plumbing.Hash) (baselineEntry, error) {
	tree, err := repo.TreeObject(sha)
	if err != nil {
		return baselineEntry{}, errInvalidBaseline
	}
	if computed, err := gitTreeHash(tree.Entries); err != nil || computed != sha {
		return baselineEntry{}, errInvalidBaseline
	}
	snapshot := baselineEntry{Name: name, Mode: filemode.Dir, SHA: sha.String()}
	seen := make(map[string]struct{}, len(tree.Entries))
	for _, entry := range tree.Entries {
		if _, duplicate := seen[entry.Name]; duplicate || strings.Contains(entry.Name, "/") || !safePublicationName(entry.Name) {
			return baselineEntry{}, errUnsafeWorkspace
		}
		seen[entry.Name] = struct{}{}
		child := baselineEntry{Name: entry.Name, Mode: entry.Mode, SHA: entry.Hash.String()}
		switch entry.Mode {
		case filemode.Dir:
			child, err = snapshotTree(repo, entry.Name, entry.Hash)
			if err != nil {
				return baselineEntry{}, err
			}
		case filemode.Regular, filemode.Executable, filemode.Symlink, filemode.Submodule:
		default:
			return baselineEntry{}, errUnsafeWorkspace
		}
		snapshot.Children = append(snapshot.Children, child)
	}
	return snapshot, nil
}

func safePublicationName(name string) bool {
	if !utf8.ValidString(name) || name == "" {
		return false
	}
	alias := strings.TrimRight(strings.ToLower(norm.NFKC.String(name)), ". ")
	if alias == "" || alias == ".git" || gitShortName(alias) {
		return false
	}
	unsafe := func(r rune) bool {
		return r == '/' || r == '\\' || r == ':' || unicode.IsControl(r) || unicode.In(r, unicode.Cf)
	}
	return strings.IndexFunc(name, unsafe) < 0 && strings.IndexFunc(alias, unsafe) < 0
}

func gitShortName(alias string) bool {
	digits, ok := strings.CutPrefix(alias, "git~")
	return ok && digits != "" && strings.IndexFunc(digits, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

type exportStream struct {
	dst       io.Writer
	digest    hash.Hash
	remaining int64
	changes   int
}

func (s *exportStream) record(record any, covered bool) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if int64(len(data)) > s.remaining {
		return errPublicationLimit
	}
	n, err := s.dst.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	s.remaining -= int64(n)
	if covered {
		_, _ = s.digest.Write(data)
	}
	return nil
}

func (s *exportStream) delete(path string) error {
	s.changes++
	return s.record(struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
	}{"delete", path}, true)
}

func (s *exportStream) put(path string, entry object.TreeEntry, data []byte) error {
	s.changes++
	return s.record(struct {
		Kind    string `json:"kind"`
		Path    string `json:"path"`
		Mode    string `json:"mode"`
		BlobSHA string `json:"blobSha"`
		Data    []byte `json:"data"`
	}{"put", path, fmt.Sprintf("%o", entry.Mode), entry.Hash.String(), data}, true)
}

type workspaceExport struct {
	root   *os.Root
	device uint64
	stream *exportStream
}

func exportWorkspace(root *os.Root, baseline publicationBaseline, out io.Writer, maxBytes int64) error {
	info, err := root.Lstat(".")
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() {
		return errUnsafeWorkspace
	}
	stream := &exportStream{dst: out, digest: sha256.New(), remaining: maxBytes}
	if err := stream.record(struct {
		Version     int    `json:"version"`
		BaseSHA     string `json:"baseSha"`
		BaseTreeSHA string `json:"baseTreeSha"`
	}{1, baseline.BaseSHA, baseline.Tree.SHA}, true); err != nil {
		return err
	}
	export := workspaceExport{root: root, device: uint64(stat.Dev), stream: stream}
	tree, err := export.directory(nil, baseline.Tree.Children, nil, false)
	if err != nil {
		return err
	}
	hash, err := gitTreeHash(tree)
	if err != nil {
		return err
	}
	if err := stream.record(struct {
		TreeSHA string `json:"treeSha"`
		Changes int    `json:"changes"`
	}{hash.String(), stream.changes}, true); err != nil {
		return err
	}
	return stream.record(struct {
		SHA256 string `json:"sha256"`
	}{hex.EncodeToString(stream.digest.Sum(nil))}, false)
}

func (e workspaceExport) open(path string, expected os.FileInfo, directory bool) (*os.File, error) {
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	if directory {
		flags |= syscall.O_DIRECTORY
	}
	file, err := openWorkspaceFile(e.root, path, flags)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	validKind := (directory && info.IsDir()) || (!directory && info.Mode().IsRegular())
	if !ok || !validKind || uint64(stat.Dev) != e.device || !os.SameFile(expected, info) || (!directory && stat.Nlink != 1) {
		file.Close()
		return nil, errUnsafeWorkspace
	}
	return file, nil
}

func (e workspaceExport) ignoreRules(domain []string, rules []gitignore.Pattern) ([]gitignore.Pattern, error) {
	path := strings.Join(append(slices.Clone(domain), ".gitignore"), "/")
	info, err := e.root.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return rules, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		// Git does not follow a symlink when reading a worktree .gitignore.
		return rules, nil
	}
	if !info.Mode().IsRegular() {
		return nil, errUnsafeWorkspace
	}
	file, err := e.open(path, info, false)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	rules = slices.Clone(rules)
	scanner := bufio.NewScanner(file)
	// Git filenames and ignore patterns cannot refer to longer Linux paths
	// than PATH_MAX. Scanner's default already leaves room for pattern escapes.
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "#") && strings.TrimSpace(line) != "" {
			rules = append(rules, gitignore.ParsePattern(line, slices.Clone(domain)))
		}
	}
	return rules, scanner.Err()
}

func (e workspaceExport) directory(domain []string, previous []baselineEntry, rules []gitignore.Pattern, ignored bool) ([]object.TreeEntry, error) {
	path := strings.Join(domain, "/")
	if path == "" {
		path = "."
	}
	info, err := e.root.Lstat(path)
	if err != nil {
		return nil, err
	}
	dir, err := e.open(path, info, true)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if !ignored {
		rules, err = e.ignoreRules(domain, rules)
		if err != nil {
			return nil, err
		}
	}
	matcher := gitignore.NewMatcher(rules)
	base := make(map[string]baselineEntry, len(previous))
	for _, entry := range previous {
		base[entry.Name] = entry
	}

	var next []object.TreeEntry
	for {
		// Iterate instead of allocating every directory entry before checking it.
		items, readErr := dir.ReadDir(128)
		for _, item := range items {
			name := item.Name()
			if len(domain) == 0 && name == ".git" {
				continue
			}
			if !safePublicationName(name) {
				return nil, errUnsafeWorkspace
			}
			full := append(slices.Clone(domain), name)
			old := base[name]
			delete(base, name)
			blocked := ignored || matcher.Match(full, item.IsDir())
			if old.Mode == filemode.Empty && blocked {
				continue
			}
			entry, err := e.entry(full, old, rules, blocked)
			if err != nil {
				return nil, err
			}
			if entry.Mode != filemode.Empty {
				next = append(next, entry)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}

	// A missing gitlink is also how an uninitialized submodule can appear.
	// Preserve empty Git trees, which have no representation in a worktree.
	for _, old := range previous {
		if _, missing := base[old.Name]; !missing {
			continue
		}
		if old.Mode == filemode.Submodule || emptyTree(old) {
			next = append(next, treeEntry(old))
		} else if err := e.remove(strings.Join(append(slices.Clone(domain), old.Name), "/"), old); err != nil {
			return nil, err
		}
	}
	return next, nil
}

func treeEntry(entry baselineEntry) object.TreeEntry {
	return object.TreeEntry{Name: entry.Name, Mode: entry.Mode, Hash: plumbing.NewHash(entry.SHA)}
}

func emptyTree(entry baselineEntry) bool {
	if entry.Mode != filemode.Dir {
		return false
	}
	for _, child := range entry.Children {
		if !emptyTree(child) {
			return false
		}
	}
	return true
}

func removable(entry baselineEntry) bool {
	switch entry.Mode {
	case filemode.Regular, filemode.Executable:
		return true
	case filemode.Dir:
		for _, child := range entry.Children {
			if !removable(child) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func (e workspaceExport) remove(path string, old baselineEntry) error {
	if old.Mode == filemode.Empty {
		return nil
	}
	if !removable(old) {
		return errUnsafeWorkspace
	}
	return e.stream.delete(path)
}

func (e workspaceExport) entry(full []string, old baselineEntry, rules []gitignore.Pattern, ignored bool) (object.TreeEntry, error) {
	name := full[len(full)-1]
	path := strings.Join(full, "/")
	info, err := e.root.Lstat(path)
	if err != nil {
		return object.TreeEntry{}, err
	}
	if old.Mode == filemode.Submodule {
		dir, err := e.open(path, info, true)
		if err != nil {
			return object.TreeEntry{}, errUnsafeWorkspace
		}
		defer dir.Close()
		if entries, err := dir.ReadDir(1); !errors.Is(err, io.EOF) || len(entries) != 0 {
			return object.TreeEntry{}, errUnsafeWorkspace
		}
		return treeEntry(old), nil
	}
	if old.Mode == filemode.Symlink {
		if info.Mode()&os.ModeSymlink == 0 {
			return object.TreeEntry{}, errUnsafeWorkspace
		}
		target, err := e.root.Readlink(path)
		if err != nil || gitBlobHash([]byte(target)).String() != old.SHA {
			return object.TreeEntry{}, errUnsafeWorkspace
		}
		return treeEntry(old), nil
	}
	if info.IsDir() {
		if old.Mode != filemode.Dir {
			if err := e.remove(path, old); err != nil {
				return object.TreeEntry{}, err
			}
		}
		children, err := e.directory(full, old.Children, rules, ignored)
		if err != nil {
			return object.TreeEntry{}, err
		}
		if len(children) == 0 {
			if emptyTree(old) {
				return treeEntry(old), nil
			}
			return object.TreeEntry{}, nil
		}
		digest, err := gitTreeHash(children)
		return object.TreeEntry{Name: name, Mode: filemode.Dir, Hash: digest}, err
	}
	if !info.Mode().IsRegular() {
		return object.TreeEntry{}, errUnsafeWorkspace
	}
	if old.Mode == filemode.Dir && !removable(old) {
		return object.TreeEntry{}, errUnsafeWorkspace
	}
	file, err := e.open(path, info, false)
	if err != nil {
		return object.TreeEntry{}, err
	}
	defer file.Close()
	entry, data, err := readPublicationFile(name, file, info, old, e.stream.remaining)
	if err != nil {
		return object.TreeEntry{}, err
	}
	if data != nil {
		if err := e.stream.put(path, entry, data); err != nil {
			return object.TreeEntry{}, err
		}
	}
	return entry, nil
}

func gitBlobHash(data []byte) plumbing.Hash {
	return plumbing.ComputeHash(plumbing.BlobObject, data)
}

func readPublicationFile(name string, file *os.File, info os.FileInfo, old baselineEntry, remaining int64) (object.TreeEntry, []byte, error) {
	h := plumbing.NewHasher(plumbing.BlobObject, info.Size())
	n, err := io.Copy(h, io.LimitReader(file, info.Size()+1))
	if err != nil || n != info.Size() {
		return object.TreeEntry{}, nil, errUnsafeWorkspace
	}
	mode, err := filemode.NewFromOSFileMode(info.Mode())
	if err != nil {
		return object.TreeEntry{}, nil, errUnsafeWorkspace
	}
	entry := object.TreeEntry{Name: name, Mode: mode, Hash: h.Sum()}
	if old.Mode == mode && old.SHA == entry.Hash.String() {
		return entry, nil, nil
	}
	// Base64 expands the bytes by 4/3 before record framing. Large unchanged
	// files are hashed above in constant memory and do not consume this budget.
	if info.Size() > (remaining/4)*3 {
		return object.TreeEntry{}, nil, errPublicationLimit
	}
	var contents bytes.Buffer
	contents.Grow(int(info.Size()))
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return object.TreeEntry{}, nil, err
	}
	n, err = io.Copy(&contents, io.LimitReader(file, info.Size()+1))
	if err != nil || n != info.Size() || gitBlobHash(contents.Bytes()) != entry.Hash {
		return object.TreeEntry{}, nil, errUnsafeWorkspace
	}
	data := contents.Bytes()
	if data == nil {
		data = []byte{}
	}
	return entry, data, nil
}
