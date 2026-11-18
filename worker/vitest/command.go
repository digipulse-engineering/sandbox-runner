package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

type capturedStream struct {
	Data      []byte `json:"data"`
	Bytes     int64  `json:"bytes"`
	Truncated bool   `json:"truncated"`
	limit     int
}

func newCapture(limit int) *capturedStream {
	return &capturedStream{Data: make([]byte, 0), limit: limit}
}

func (s *capturedStream) Write(data []byte) (int, error) {
	remaining := min(len(data), s.limit-len(s.Data))
	s.Data = append(s.Data, data[:remaining]...)
	s.Bytes += int64(len(data))
	s.Truncated = s.Bytes > int64(s.limit)
	return len(data), nil
}

type commandReceipt struct {
	ExitCode   *int            `json:"exitCode,omitempty"`
	Signal     syscall.Signal  `json:"signal,omitempty"`
	StartError string          `json:"startError,omitempty"`
	Stdout     *capturedStream `json:"stdout,omitempty"`
	Stderr     *capturedStream `json:"stderr,omitempty"`
}

func readArguments(input io.Reader, limit int64) ([]string, error) {
	data, err := io.ReadAll(io.LimitReader(input, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("could not read bounded command input")
	}
	var argv []string
	if err := json.Unmarshal(data, &argv); err != nil || len(argv) == 0 || argv[0] == "" {
		return nil, errors.New("invalid command arguments")
	}
	for _, arg := range argv {
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("invalid command argument")
		}
	}
	return argv, nil
}

func commandStartError(err error) string {
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, syscall.ENOENT):
		return "not_found"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return "permission_denied"
	case errors.Is(err, syscall.ENOEXEC):
		return "invalid_executable"
	case errors.Is(err, syscall.E2BIG):
		return "arguments_too_large"
	default:
		return "start_failed"
	}
}

func runCommand(argv []string, logLimit int) commandReceipt {
	// os/exec calls the executable directly and does not retry ENOEXEC with a shell.
	command := exec.Command(argv[0], argv[1:]...)
	stdout, stderr := newCapture(logLimit), newCapture(logLimit)
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Start(); err != nil {
		return commandReceipt{StartError: commandStartError(err)}
	}
	var processError *exec.ExitError
	if err := command.Wait(); err != nil && !errors.As(err, &processError) {
		return commandReceipt{StartError: "process_lost"}
	}
	status := command.ProcessState.Sys().(syscall.WaitStatus)
	if status.Signaled() {
		return commandReceipt{Signal: status.Signal(), Stdout: stdout, Stderr: stderr}
	}
	exitCode := status.ExitStatus()
	return commandReceipt{ExitCode: &exitCode, Stdout: stdout, Stderr: stderr}
}

func launch() error {
	if len(os.Args) != 3 {
		return errors.New("invalid launcher configuration")
	}
	inputLimit, inputError := strconv.ParseInt(os.Args[1], 10, 32)
	logLimit, logError := strconv.Atoi(os.Args[2])
	if inputError != nil || logError != nil || inputLimit < 1 || logLimit < 1 {
		return errors.New("invalid launcher limits")
	}
	argv, err := readArguments(os.Stdin, inputLimit)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(runCommand(argv, logLimit))
}

func main() {
	if err := launch(); err != nil {
		fmt.Fprintln(os.Stderr, "sandbox-runner: command supervisor failed")
		os.Exit(125)
	}
}
