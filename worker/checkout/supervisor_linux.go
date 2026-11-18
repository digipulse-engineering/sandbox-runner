//go:build linux

package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func launchSupervisedCodex(args []string) error {
	if len(args) < 2 || args[1] != "codex" {
		return errSupervisorUnverified
	}
	ms, err := strconv.ParseUint(args[0], 10, 31)
	if err != nil || ms == 0 {
		return errSupervisorUnverified
	}
	return superviseCodex(exec.Command("/usr/local/bin/codex", args[2:]...), time.Duration(ms)*time.Millisecond)
}

func superviseCodex(command *exec.Cmd, drainBudget time.Duration) error {
	// no_new_privs is thread-local. Start the child from the same OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := verifyWorkspaceIdentity(); err != nil {
		return errSupervisorUnverified
	}
	if unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != nil ||
		unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0) != nil ||
		unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != nil {
		return errSupervisorUnverified
	}
	// Check both operations before starting Codex. Some development runtimes
	// return ENOSYS for pidfd_open even though Go can create a child pidfd.
	self, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		return errSupervisorUnverified
	}
	defer unix.Close(self)
	if unix.PidfdSendSignal(self, 0, nil, 0) != nil {
		return errSupervisorUnverified
	}

	out, outWriter, err := os.Pipe()
	if err != nil {
		return errSupervisorUnverified
	}
	defer out.Close()
	defer outWriter.Close()
	stderr, errWriter, err := os.Pipe()
	if err != nil {
		return errSupervisorUnverified
	}
	defer stderr.Close()
	defer errWriter.Close()
	// Only the supervisor owns the parent's output pipes. A descendant that
	// kills it cannot keep the adapter waiting on a pipe inherited by Codex.
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, outWriter, errWriter
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	leader := -1
	command.SysProcAttr = &syscall.SysProcAttr{PidFD: &leader}
	if err := command.Start(); err != nil {
		return errSupervisorUnverified
	}
	if leader < 0 {
		// The direct child cannot have its PID reused until this process reaps
		// it. No wait has started yet.
		leader, err = unix.PidfdOpen(command.Process.Pid, 0)
		if err != nil {
			return errSupervisorUnverified
		}
	}
	defer unix.Close(leader)
	outWriter.Close()
	errWriter.Close()

	copied := make(chan error, 2)
	copyStream := func(destination io.Writer, source io.Reader) {
		_, err := io.Copy(destination, source)
		copied <- err
	}
	go copyStream(os.Stdout, out)
	go copyStream(os.Stderr, stderr)
	waited := make(chan *os.ProcessState, 1)
	go func() {
		// The private pipes must stay open until adopted descendants exit,
		// so wait on the child without closing those pipes.
		state, _ := command.Process.Wait()
		waited <- state
	}()
	state, interrupted, err := waitForCodex(waited, signals, leader, drainBudget)
	if err != nil {
		return err
	}
	if err := drainCodexDescendants(time.Now().Add(drainBudget)); err != nil {
		return err
	}
	for range 2 {
		if err := <-copied; err != nil {
			return errSupervisorUnverified
		}
	}
	select {
	case <-signals:
		interrupted = true
	default:
	}
	if interrupted {
		return errSupervisorInterrupted
	}
	if code := state.ExitCode(); code > 0 {
		return supervisedExit(code)
	} else if code < 0 {
		return errSupervisorUnverified
	}
	return nil
}

func waitForCodex(waited <-chan *os.ProcessState, signals <-chan os.Signal, leader int, budget time.Duration) (*os.ProcessState, bool, error) {
	select {
	case state := <-waited:
		if state == nil {
			return nil, false, errSupervisorUnverified
		}
		return state, false, nil
	case sig := <-signals:
		if err := unix.PidfdSendSignal(leader, sig.(syscall.Signal), nil, 0); err != nil && !errors.Is(err, unix.ESRCH) {
			return nil, true, errSupervisorUnverified
		}
	}
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case state := <-waited:
		if state == nil {
			return nil, true, errSupervisorUnverified
		}
		return state, true, nil
	case <-timer.C:
		_ = unix.PidfdSendSignal(leader, unix.SIGKILL, nil, 0)
		return nil, true, errSupervisorTimeout
	}
}

func drainCodexDescendants(deadline time.Time) error {
	for {
		reaped, err := unix.Wait4(-1, nil, unix.WNOHANG, nil)
		switch {
		case errors.Is(err, unix.ECHILD):
			return nil
		case err != nil && !errors.Is(err, unix.EINTR):
			return errSupervisorUnverified
		}
		if !time.Now().Before(deadline) {
			return errSupervisorTimeout
		}
		if reaped > 0 || errors.Is(err, unix.EINTR) {
			continue
		}
		pids, err := adoptedCodexChildren()
		if err != nil {
			return err
		}
		for pid := range pids {
			if err := stopCodexDescendant(pid, deadline); err != nil {
				return err
			}
		}
		// /proc's children list can omit a child that exits during enumeration.
		// Only wait4/ECHILD proves completion. Yield before rediscovering.
		if len(pids) == 0 {
			time.Sleep(time.Millisecond)
		}
	}
}

func adoptedCodexChildren() (map[int]struct{}, error) {
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return nil, errSupervisorUnverified
	}
	pids := make(map[int]struct{})
	for _, task := range tasks {
		children, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "children"))
		if processGone(err) {
			continue
		}
		if err != nil {
			return nil, errSupervisorUnverified
		}
		for _, raw := range strings.Fields(string(children)) {
			pid, err := strconv.Atoi(raw)
			if err != nil || pid <= 1 {
				return nil, errSupervisorUnverified
			}
			pids[pid] = struct{}{}
		}
	}
	return pids, nil
}

func processGone(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, unix.ESRCH)
}

func exactProcFields(data []byte, name, expected string, count int) bool {
	values := statusFields(data, name)
	if len(values) != count {
		return false
	}
	for _, value := range values {
		if value != expected {
			return false
		}
	}
	return true
}

func supervisedChild(status []byte, parent string) bool {
	return exactProcFields(status, "PPid:", parent, 1) &&
		exactProcFields(status, "Uid:", strconv.Itoa(agentUID), 4) &&
		exactProcFields(status, "Gid:", strconv.Itoa(agentGID), 4) &&
		exactProcFields(status, "NoNewPrivs:", "1", 1) &&
		exactProcFields(status, "CapEff:", "0000000000000000", 1) &&
		exactProcFields(status, "CapPrm:", "0000000000000000", 1) &&
		exactProcFields(status, "CapAmb:", "0000000000000000", 1)
}

func stopCodexDescendant(pid int, deadline time.Time) error {
	if !time.Now().Before(deadline) {
		return errSupervisorTimeout
	}
	fd, err := unix.PidfdOpen(pid, 0)
	if processGone(err) {
		return nil
	}
	if err != nil {
		return errSupervisorUnverified
	}
	defer unix.Close(fd)
	identity := strconv.Itoa(pid)
	info, err := os.ReadFile("/proc/self/fdinfo/" + strconv.Itoa(fd))
	if err != nil {
		return errSupervisorUnverified
	}
	if exactProcFields(info, "Pid:", "-1", 1) {
		return nil
	}
	if !exactProcFields(info, "Pid:", identity, 1) {
		return errSupervisorUnverified
	}
	status, err := os.ReadFile("/proc/" + identity + "/status")
	if processGone(err) {
		return nil
	}
	if err != nil || !supervisedChild(status, strconv.Itoa(os.Getpid())) {
		return errSupervisorUnverified
	}
	if err := unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0); err != nil {
		if processGone(err) {
			return nil
		}
		return errSupervisorUnverified
	}
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errSupervisorTimeout
		}
		ready := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		_, err := unix.Poll(ready, int((remaining+time.Millisecond-1)/time.Millisecond))
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return errSupervisorUnverified
		}
		if ready[0].Revents&unix.POLLIN != 0 {
			return nil
		}
		return errSupervisorTimeout
	}
}
