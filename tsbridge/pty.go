package main

import (
	"io"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// runPty runs a program inside a pseudo-terminal, relaying our stdin/stdout.
// Official sign-in programs (Claude Code, Gemini CLI) expect a real terminal.
// Usage: libtsbridge.so pty <program> [args...]
func runPty(args []string) int {
	if len(args) == 0 {
		return 2
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLUMNS=200", "LINES=50")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 200, Rows: 50})
	if err != nil {
		os.Stderr.WriteString("pty: " + err.Error() + "\n")
		return 1
	}
	defer f.Close()
	go func() { _, _ = io.Copy(f, os.Stdin) }()
	_, _ = io.Copy(os.Stdout, f)
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		return 1
	}
	return 0
}
