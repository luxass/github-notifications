package app

import (
	"os"
	"strings"
	"testing"

	"github.com/luxass/github-notifications/internal/github"
)

func TestExampleConfigLoadsAndCompiles(t *testing.T) {
	source, err := os.ReadFile("../../config.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	config, err := decodeConfig(strings.NewReader(string(source)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewPoller(config, github.NewClient("test", nil), nil); err != nil {
		t.Fatal(err)
	}
}

func TestConfigRejectsUnknownFields(t *testing.T) {
	if _, err := decodeConfig(strings.NewReader("server:\n  host: 127.0.0.1\n  port: 3001\n  schedule: '0 * * * * *'\n  unexpected: true\ngithub:\n  tokenEnv: TOKEN\n  maxPages: 5\nrules: []\n")); err == nil {
		t.Fatal("expected unknown config field to fail")
	}
}
