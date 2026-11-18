//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/go-git/go-git/v5"
	"golang.org/x/sys/unix"
)

const (
	baselineDir  = "/run/sandbox-runner"
	baselineFile = "github-publication.json"
	agentUID     = 10001
	agentGID     = 10001
)

func openWorkspaceFile(root *os.Root, path string, flags int) (*os.File, error) {
	current, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer func() { current.Close() }()
	mount, err := descriptorMount(current)
	if err != nil {
		return nil, err
	}
	segments := strings.Split(path, "/")
	for index, segment := range segments {
		if path != "." && !safePublicationName(segment) {
			return nil, errUnsafeWorkspace
		}
		last := index == len(segments)-1
		options := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NONBLOCK
		if last {
			options = flags
		}
		fd, err := unix.Openat(int(current.Fd()), segment, options|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		next := os.NewFile(uintptr(fd), path)
		// st_dev alone cannot detect a bind mount on the same filesystem.
		// Check each descriptor before reading from it or descending into it.
		if currentMount, err := descriptorMount(next); err != nil || currentMount != mount {
			next.Close()
			return nil, errUnsafeWorkspace
		}
		if last {
			return next, nil
		}
		current.Close()
		current = next
	}
	return nil, errUnsafeWorkspace
}

func descriptorMount(file *os.File) (string, error) {
	metadata, err := os.ReadFile("/proc/self/fdinfo/" + strconv.FormatUint(uint64(file.Fd()), 10))
	if err != nil {
		return "", errUnsafeWorkspace
	}
	ids := statusFields(metadata, "mnt_id:")
	if len(ids) != 1 {
		return "", errUnsafeWorkspace
	}
	return ids[0], nil
}

func privateRoot(mode os.FileMode, path string) bool {
	info, err := os.Lstat(path)
	if err != nil || info.Mode() != mode {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0 && (mode.IsDir() || stat.Nlink == 1)
}

func saveBaseline(sha string) error {
	if err := os.Mkdir(baselineDir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if !privateRoot(os.ModeDir|0700, baselineDir) {
		return errInvalidBaseline
	}
	repo, err := git.PlainOpen(workspace)
	if err != nil {
		return errInvalidBaseline
	}
	baseline, err := snapshotBaseline(repo, sha)
	if err != nil {
		return err
	}

	path := filepath.Join(baselineDir, baselineFile)
	// The agent cannot reach this directory. Do not replace an existing
	// snapshot, even after a repeated request or an incomplete first write.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errInvalidBaseline
	}
	if err := json.NewEncoder(file).Encode(baseline); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func loadBaseline(sha string) (publicationBaseline, error) {
	path := filepath.Join(baselineDir, baselineFile)
	if !privateRoot(os.ModeDir|0700, baselineDir) || !privateRoot(0600, path) {
		return publicationBaseline{}, errInvalidBaseline
	}
	file, err := os.Open(path)
	if err != nil {
		return publicationBaseline{}, errInvalidBaseline
	}
	defer file.Close()
	var baseline publicationBaseline
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&baseline); err != nil || baseline.BaseSHA != sha {
		return publicationBaseline{}, errInvalidBaseline
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return publicationBaseline{}, errInvalidBaseline
	}
	return baseline, nil
}

func agentQuiescent() error {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return errWorkspaceBusy
	}
	agent := strconv.Itoa(agentUID)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		status, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		if errors.Is(err, os.ErrNotExist) {
			continue // The process exited between enumeration and read.
		}
		if err != nil {
			return errWorkspaceBusy
		}
		state := statusFields(status, "State:")
		if len(state) == 0 {
			return errWorkspaceBusy
		}
		if terminatedThreadGroup(state[0], status) {
			continue
		}
		uids := statusFields(status, "Uid:")
		if len(uids) != 4 {
			return errWorkspaceBusy
		}
		for _, uid := range uids {
			if uid == agent {
				return errWorkspaceBusy
			}
		}
	}
	return nil
}

func dropWorkspacePrivileges() error {
	if err := syscall.Setgroups(nil); err != nil {
		return err
	}
	if err := syscall.Setgid(agentGID); err != nil {
		return err
	}
	if err := syscall.Setuid(agentUID); err != nil {
		return err
	}
	return verifyWorkspaceIdentity()
}

func verifyWorkspaceIdentity() error {
	if os.Getuid() != agentUID || os.Geteuid() != agentUID || os.Getgid() != agentGID || os.Getegid() != agentGID {
		return errUnsafeWorkspace
	}
	groups, err := os.Getgroups()
	if err != nil {
		return err
	}
	for _, group := range groups {
		if group != agentGID {
			return errUnsafeWorkspace
		}
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return err
	}
	for _, name := range []string{"CapEff:", "CapPrm:", "CapAmb:"} {
		values := statusFields(status, name)
		if len(values) != 1 || values[0] == "" || strings.Trim(values[0], "0") != "" {
			return errUnsafeWorkspace
		}
	}
	return nil
}

func launchPublicationAgent(args []string) error {
	if len(args) == 0 || args[0] != "claude" {
		return errUnsafeWorkspace
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := verifyWorkspaceIdentity(); err != nil {
		return err
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	executable := "/usr/local/bin/" + args[0]
	return syscall.Exec(executable, args, os.Environ())
}

func runPublicationCommand(args []string) error {
	if args[0] == "agent" {
		return launchPublicationAgent(args[1:])
	}
	if args[0] == "supervise-codex" {
		return launchSupervisedCodex(args[1:])
	}
	if os.Getuid() != 0 || os.Geteuid() != 0 {
		return errUnsafeWorkspace
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	sha := flags.String("sha", "", "")
	maxBytes := flags.Int64("max-bytes", 0, "")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || !shaPattern.MatchString(*sha) {
		return errInvalidBaseline
	}
	if command == "snapshot" && *maxBytes == 0 {
		return saveBaseline(*sha)
	}
	if command != "export" || *maxBytes <= 0 {
		return errPublicationLimit
	}
	if err := agentQuiescent(); err != nil {
		return err
	}
	baseline, err := loadBaseline(*sha)
	if err != nil {
		return err
	}
	if err := dropWorkspacePrivileges(); err != nil {
		return err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return err
	}
	defer root.Close()
	return exportWorkspace(root, baseline, os.Stdout, *maxBytes)
}
