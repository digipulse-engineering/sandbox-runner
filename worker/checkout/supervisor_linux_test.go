//go:build linux

package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const supervisorTestMode = "SANDBOX_RUNNER_TEST_CODEX_SUPERVISOR"

func supervisorFixture(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestCodexSupervisorFixture$")
	cmd.Env = []string{supervisorTestMode + "=" + mode}
	return cmd
}

func TestCodexSupervisorFixture(t *testing.T) {
	mode := os.Getenv(supervisorTestMode)
	if mode == "" {
		t.Skip("subprocess fixture")
	}
	if strings.HasPrefix(mode, "supervisor/") {
		variant := strings.TrimPrefix(mode, "supervisor/")
		budget := 25 * time.Second // Same as the product checkout/export fixture budget.
		if variant == "timeout" || variant == "drain-timeout" {
			budget = time.Nanosecond // Deliberately expired recovery window.
		}
		err := superviseCodex(supervisorFixture("agent/"+variant), budget)
		var code supervisedExit
		if errors.As(err, &code) {
			os.Exit(int(code))
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, publicationErrorCode(err))
			os.Exit(1)
		}
		os.Exit(0)
	}
	switch mode {
	case "agent/escape", "agent/drain-timeout":
		cmd := supervisorFixture("descendant")
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if err := cmd.Process.Release(); err != nil {
			t.Fatal(err)
		}
		fmt.Println("terminal")
	case "descendant":
		_, _ = io.Copy(io.Discard, os.Stdin)
	case "agent/nonzero":
		fmt.Println("terminal")
		os.Exit(17)
	case "agent/kill-supervisor":
		fmt.Println("terminal")
		if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
		parent := os.Getppid()
		if _, err := os.Readlink("/proc/" + strconv.Itoa(parent) + "/fd/1"); !errors.Is(err, os.ErrPermission) {
			t.Fatal("the agent can inspect the supervisor's output descriptor")
		}
		fd, err := unix.PidfdOpen(parent, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer unix.Close(fd)
		if err := unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0); err != nil {
			t.Fatal(err)
		}
		// Keep the agent's output descriptors open until the outer test
		// closes its input lease. The adapter must still observe close.
		_, _ = io.Copy(io.Discard, os.Stdin)
	case "agent/cancel":
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		fmt.Println("ready")
		<-signals
		fmt.Println("forwarded")
	case "agent/timeout":
		signal.Ignore(syscall.SIGTERM)
		fmt.Println("ready")
		_, _ = io.Copy(io.Discard, os.Stdin)
	default:
		t.Fatal("unknown supervisor fixture")
	}
	os.Exit(0)
}

func exitCodeOf(err error) int {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		return -2
	}
	return 0
}

func runSupervisorFixture(t *testing.T, mode, expectedLine string, act func(*os.File, int)) (int, string, string) {
	t.Helper()
	cmd := supervisorFixture("supervisor/" + mode)
	pidfd := -1
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{Uid: agentUID, Gid: agentGID}, PidFD: &pidfd,
	}
	lease, release, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	defer release.Close()
	cmd.Stdin = lease
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if pidfd >= 0 {
		defer unix.Close(pidfd)
	}
	outFile, ok := out.(*os.File)
	if !ok || outFile.SetReadDeadline(time.Now().Add(25*time.Second)) != nil {
		t.Fatal("cannot bound subprocess output")
	}
	reader := bufio.NewReader(out)
	first := ""
	if expectedLine != "" {
		first, err = reader.ReadString('\n')
		if err != nil || first != expectedLine+"\n" {
			t.Fatalf("unexpected first line %q (%v)", first, err)
		}
	}
	if act != nil {
		if pidfd < 0 {
			t.Fatal("test parent could not pin supervisor")
		}
		act(release, pidfd)
	}
	rest, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("adapter output remained open: %v", err)
	}
	return exitCodeOf(cmd.Wait()), first + string(rest), stderr.String()
}

func TestCodexSupervisorLinux(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires a disposable Linux container with root for the fixture's UID switch")
	}
	fd, err := unix.PidfdOpen(os.Getpid(), 0)
	if errors.Is(err, unix.ENOSYS) {
		code, stdout, stderr := runSupervisorFixture(t, "escape", "", nil)
		if code != 1 || stdout != "" || stderr != errSupervisorUnverified.Error()+"\n" {
			t.Fatalf("unsupported pidfd did not fail before agent start: %d %q %q", code, stdout, stderr)
		}
		t.Log("pidfd_open ENOSYS: Codex was not launched")
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	unix.Close(fd)
	t.Run("adopts a setsid descendant before exit zero", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "escape", "terminal", nil)
		if code != 0 || stdout != "terminal\n" || stderr != "" {
			t.Fatalf("unverified exit: %d %q %q", code, stdout, stderr)
		}
	})
	t.Run("preserves a completed child's nonzero exit", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "nonzero", "terminal", nil)
		if code != 17 || stdout != "terminal\n" || stderr != "" {
			t.Fatalf("child exit changed: %d %q %q", code, stdout, stderr)
		}
	})
	t.Run("a descendant kills its supervisor after the terminal frame", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "kill-supervisor", "terminal", func(input *os.File, _ int) {
			if _, err := input.Write([]byte{1}); err != nil {
				t.Fatal(err)
			}
		})
		if code != -1 || stdout != "terminal\n" || stderr != "" {
			t.Fatalf("the adapter could not see the supervisor signal and terminal frame: %d %q %q", code, stdout, stderr)
		}
	})
	sendTerm := func(t *testing.T) func(*os.File, int) {
		return func(_ *os.File, fd int) {
			if err := unix.PidfdSendSignal(fd, unix.SIGTERM, nil, 0); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Run("cancellation reaches Codex but cannot attest success", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "cancel", "ready", sendTerm(t))
		if code != 1 || stdout != "ready\nforwarded\n" || stderr != errSupervisorInterrupted.Error()+"\n" {
			t.Fatalf("cancellation was not forwarded or incorrectly succeeded: %d %q %q", code, stdout, stderr)
		}
	})
	t.Run("a child ignoring cancellation expires the configured window", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "timeout", "ready", sendTerm(t))
		if code != 1 || stdout != "ready\n" || stderr != errSupervisorTimeout.Error()+"\n" {
			t.Fatalf("timeout did not fail closed: %d %q %q", code, stdout, stderr)
		}
	})
	t.Run("a detached child cannot release a terminal frame after the drain budget", func(t *testing.T) {
		code, stdout, stderr := runSupervisorFixture(t, "drain-timeout", "", nil)
		if code != 1 || (stdout != "" && stdout != "terminal\n") || stderr != errSupervisorTimeout.Error()+"\n" {
			t.Fatalf("drain timeout incorrectly succeeded: %d %q %q", code, stdout, stderr)
		}
	})
}

func TestSupervisorRequiresExactChildIdentity(t *testing.T) {
	const valid = "PPid:\t123\nUid:\t10001 10001 10001 10001\nGid:\t10001 10001 10001 10001\n" +
		"NoNewPrivs:\t1\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapAmb:\t0000000000000000\n"
	if !supervisedChild([]byte(valid), "123") {
		t.Fatal("rejected a scoped agent child")
	}
	for _, invalid := range []string{
		strings.Replace(valid, "123", "124", 1),
		strings.Replace(valid, "10001", "0", 1),
		strings.Replace(valid, "NoNewPrivs:\t1", "NoNewPrivs:\t0", 1),
		strings.Replace(valid, "0000000000000000", "0000000000000001", 1),
	} {
		if supervisedChild([]byte(invalid), "123") {
			t.Fatal("accepted a different process scope")
		}
	}
}
