//go:build !linux

package main

import (
	"errors"
	"os"
)

func openWorkspaceFile(root *os.Root, path string, flags int) (*os.File, error) {
	return root.OpenFile(path, flags, 0)
}

func runPublicationCommand(_ []string) error {
	return errors.New("Linux sandbox required")
}
