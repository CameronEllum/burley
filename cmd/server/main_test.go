package main

import (
	"net"
	"strconv"
	"testing"
)

func TestCreateListenerUsesFreePreferredPort(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	probe.Close()

	ln, actual, err := createListener(addr)
	if err != nil {
		t.Fatalf("createListener(%q): %v", addr, err)
	}
	defer ln.Close()

	if actual != addr {
		t.Fatalf("actual = %q, want preferred %q", actual, addr)
	}
	conn, err := net.Dial("tcp", actual)
	if err != nil {
		t.Fatalf("dial %q: %v", actual, err)
	}
	conn.Close()
}

func TestCreateListenerIncrementsPastBusyPort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	busyAddr := busy.Addr().String()
	host, portStr, err := net.SplitHostPort(busyAddr)
	if err != nil {
		t.Fatal(err)
	}
	startPort, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}

	ln, actual, err := createListener(busyAddr)
	if err != nil {
		t.Fatalf("createListener(%q): %v", busyAddr, err)
	}
	defer ln.Close()

	if actual == busyAddr {
		t.Fatalf("createListener returned the busy address %q", busyAddr)
	}
	actualHost, actualPortStr, err := net.SplitHostPort(actual)
	if err != nil {
		t.Fatalf("split actual %q: %v", actual, err)
	}
	if actualHost != host {
		t.Fatalf("host = %q, want %q", actualHost, host)
	}
	actualPort, err := strconv.Atoi(actualPortStr)
	if err != nil {
		t.Fatal(err)
	}
	if actualPort < startPort+1 || actualPort > startPort+20 {
		t.Fatalf("port = %d, want within %d..%d", actualPort, startPort+1, startPort+20)
	}

	conn, err := net.Dial("tcp", actual)
	if err != nil {
		t.Fatalf("dial %q: %v", actual, err)
	}
	conn.Close()
}
