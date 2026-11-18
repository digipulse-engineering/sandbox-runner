package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"
)

type receiptRecord struct {
	Version     int    `json:"version"`
	BaseSHA     string `json:"baseSha"`
	BaseTreeSHA string `json:"baseTreeSha"`
	TreeSHA     string `json:"treeSha"`
	Changes     int    `json:"changes"`
	Kind        string `json:"kind"`
	Path        string `json:"path"`
	Mode        string `json:"mode"`
	BlobSHA     string `json:"blobSha"`
	Data        []byte `json:"data"`
	SHA256      string `json:"sha256"`
}

func fixtureFile(t *testing.T, dir, name, contents string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func fixtureBaseline(t *testing.T, files map[string]string) (string, *git.Repository, publicationBaseline) {
	t.Helper()
	dir := t.TempDir()
	repo, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	for name, contents := range files {
		fixtureFile(t, dir, name, contents, 0644)
		if _, err := wt.Add(name); err != nil {
			t.Fatal(err)
		}
	}
	sha, err := wt.Commit("fixture", &git.CommitOptions{Author: &object.Signature{
		Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(0, 0),
	}})
	if err != nil {
		t.Fatal(err)
	}
	base, err := snapshotBaseline(repo, sha.String())
	if err != nil {
		t.Fatal(err)
	}
	return dir, repo, base
}

func fixtureExport(t *testing.T, dir string, base publicationBaseline, limit int64) ([]byte, error) {
	t.Helper()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	var out bytes.Buffer
	err = exportWorkspace(root, base, &out, limit)
	return out.Bytes(), err
}

func receipt(t *testing.T, data []byte) []receiptRecord {
	t.Helper()
	lines := bytes.Split(data, []byte("\n"))
	if len(lines) < 4 || len(lines[len(lines)-1]) != 0 {
		t.Fatal("incomplete export")
	}
	lines = lines[:len(lines)-1]
	records := make([]receiptRecord, len(lines))
	for i, line := range lines {
		if err := json.Unmarshal(line, &records[i]); err != nil {
			t.Fatal(err)
		}
	}
	last := records[len(records)-1]
	digest := sha256.Sum256(data[:len(data)-len(lines[len(lines)-1])-1])
	if last.SHA256 != hex.EncodeToString(digest[:]) || records[len(records)-2].Changes != len(records)-3 {
		t.Fatal("invalid export receipt")
	}
	return records
}

func TestExportTrackedNewAndDeletedWithVerifiedTree(t *testing.T) {
	baseFiles := map[string]string{
		".gitignore": "ignored/\n*.tmp\n!tracked.tmp\n",
		"keep.txt":   "keep\n", "change.txt": "before\n", "gone/sub.txt": "delete\n", "tracked.tmp": "before\n",
		"file-to-dir": "file\n", "dir-to-file/old.txt": "child\n",
	}
	dir, repo, base := fixtureBaseline(t, baseFiles)
	if _, err := snapshotBaseline(repo, strings.Repeat("f", 40)); !errors.Is(err, errInvalidBaseline) {
		t.Fatal("accepted different HEAD")
	}
	for _, name := range []string{"gone", "dir-to-file", "file-to-dir", ".git"} {
		if err := os.RemoveAll(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(dir, ".git")); err != nil {
		t.Fatal(err)
	}
	fixtureFile(t, dir, "change.txt", "after\n", 0755)
	fixtureFile(t, dir, "tracked.tmp", "tracked despite ignore\n", 0644)
	fixtureFile(t, dir, "new/empty.txt", "", 0644)
	fixtureFile(t, dir, "new/.gitignore", "exclude.txt\n", 0644)
	fixtureFile(t, dir, "new/exclude.txt", "must not export\n", 0644)
	fixtureFile(t, dir, "ignored/sub", "must not export\n", 0644)
	fixtureFile(t, dir, "temp.tmp", "must not export\n", 0644)
	fixtureFile(t, dir, "file-to-dir/add.txt", "now nested\n", 0644)
	fixtureFile(t, dir, "dir-to-file", "now a file\n", 0644)

	out, err := fixtureExport(t, dir, base, 8192)
	if err != nil {
		t.Fatal(err)
	}
	records := receipt(t, out)
	if records[0].Version != 1 || records[0].BaseSHA != base.BaseSHA || records[0].BaseTreeSHA != base.Tree.SHA {
		t.Fatal("incorrect base attribution")
	}
	want := map[string][]string{
		"change.txt": {"put", "100755", "after\n"}, "tracked.tmp": {"put", "100644", "tracked despite ignore\n"},
		"gone": {"delete", "", ""}, "new/empty.txt": {"put", "100644", ""},
		"new/.gitignore": {"put", "100644", "exclude.txt\n"},
		"file-to-dir":    {"delete", "", ""}, "file-to-dir/add.txt": {"put", "100644", "now nested\n"},
		"dir-to-file": {"put", "100644", "now a file\n"},
	}
	got := map[string][]string{}
	for _, change := range records[1 : len(records)-2] {
		if _, repeated := got[change.Path]; repeated {
			t.Fatal("duplicate change")
		}
		got[change.Path] = []string{change.Kind, change.Mode, string(change.Data)}
		if change.Kind == "put" && change.BlobSHA != gitBlobHash(change.Data).String() {
			t.Fatal("invalid blob SHA")
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changes = %#v", got)
	}

	_, expectedRepo, expected := fixtureBaseline(t, map[string]string{
		".gitignore": baseFiles[".gitignore"], "keep.txt": "keep\n", "change.txt": "after\n",
		"tracked.tmp": "tracked despite ignore\n", "new/empty.txt": "", "new/.gitignore": "exclude.txt\n",
		"file-to-dir/add.txt": "now nested\n", "dir-to-file": "now a file\n",
	})
	// Set only the executable mode on the independent expected tree.
	wt, err := expectedRepo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	fixtureFile(t, wt.Filesystem.Root(), "change.txt", "after\n", 0755)
	if _, err := wt.Add("change.txt"); err != nil {
		t.Fatal(err)
	}
	expectedSHA, err := wt.Commit("expected mode", &git.CommitOptions{Author: &object.Signature{
		Name: "Fixture", Email: "fixture@example.invalid", When: time.Unix(0, 0),
	}})
	if err != nil {
		t.Fatal(err)
	}
	expected, err = snapshotBaseline(expectedRepo, expectedSHA.String())
	if err != nil || records[len(records)-2].TreeSHA != expected.Tree.SHA {
		t.Fatalf("candidate tree = %s, expected %s, error %v", records[len(records)-2].TreeSHA, expected.Tree.SHA, err)
	}
}

func TestExportRefusesUnsafeEntriesBeforeReadingThem(t *testing.T) {
	for _, kind := range []string{"outside symlink", "inside symlink", "hardlink", "fifo", "git alias"} {
		t.Run(kind, func(t *testing.T) {
			dir, _, base := fixtureBaseline(t, map[string]string{"ordinary": "tracked\n"})
			outside := t.TempDir()
			fixtureFile(t, outside, "outside", "outside bytes must never appear", 0644)
			path := filepath.Join(dir, "intruder")
			var err error
			switch kind {
			case "outside symlink":
				err = os.Symlink(filepath.Join(outside, "outside"), path)
			case "inside symlink":
				err = os.Symlink("ordinary", path)
			case "hardlink":
				err = os.Link(filepath.Join(outside, "outside"), path)
			case "fifo":
				err = syscall.Mkfifo(path, 0600)
			case "git alias":
				fixtureFile(t, dir, "nested/.ｇｉｔ/config", "synthetic\n", 0644)
			}
			if err != nil {
				t.Fatal(err)
			}
			out, err := fixtureExport(t, dir, base, 8192)
			if !errors.Is(err, errUnsafeWorkspace) || bytes.Contains(out, []byte("outside bytes")) ||
				bytes.Contains(out, []byte(`"sha256"`)) {
				t.Fatalf("unsafe workspace did not fail closed: %v", err)
			}
		})
	}
}

func TestExportWireBudgetCountsFooterAndAllowsLargeUnchangedFiles(t *testing.T) {
	dir, _, base := fixtureBaseline(t, map[string]string{"unchanged": strings.Repeat("x", 4096)})
	out, err := fixtureExport(t, dir, base, 1024)
	if err != nil {
		t.Fatal(err)
	}
	records := receipt(t, out)
	if records[1].TreeSHA != base.Tree.SHA || records[1].Changes != 0 {
		t.Fatal("changed an unchanged tree")
	}
	if _, err := fixtureExport(t, dir, base, int64(len(out))); err != nil {
		t.Fatal("rejected exact budget", err)
	}
	partial, err := fixtureExport(t, dir, base, int64(len(out)-1))
	if !errors.Is(err, errPublicationLimit) || bytes.Contains(partial, []byte(`"sha256"`)) {
		t.Fatal("accepted truncated footer")
	}
	fixtureFile(t, dir, "unchanged", strings.Repeat("y", 4096), 0644)
	if _, err := fixtureExport(t, dir, base, 1024); !errors.Is(err, errPublicationLimit) {
		t.Fatal("accepted oversized change", err)
	}
}

func TestOnlyALoneZombieCanBeIgnoredBeforeExport(t *testing.T) {
	if !terminatedThreadGroup("Z", []byte("Threads:\t1\n")) {
		t.Fatal("rejected a reaped-in-wait process with no executing threads")
	}
	if terminatedThreadGroup("Z", []byte("Threads:\t2\n")) || terminatedThreadGroup("Z", nil) ||
		terminatedThreadGroup("S", []byte("Threads:\t1\n")) {
		t.Fatal("accepted an unverified or live thread group")
	}
}
