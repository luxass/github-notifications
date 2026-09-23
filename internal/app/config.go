package app

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/robfig/cron/v3"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Server ServerConfig `yaml:"server"`
	GitHub GitHubConfig `yaml:"github"`
	Rules  []RuleConfig `yaml:"rules"`
}

type ServerConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Schedule string `yaml:"schedule"`
}

type GitHubConfig struct {
	TokenEnv string `yaml:"tokenEnv"`
	MaxPages int    `yaml:"maxPages"`
}

type RuleConfig struct {
	Name    string         `yaml:"name"`
	When    string         `yaml:"when"`
	Actions []ActionConfig `yaml:"actions"`
	Stop    bool           `yaml:"stop"`
}

type ActionConfig struct {
	Type string `yaml:"type"`
}

func LoadConfig(path string) (Config, error) {
	if path == "" {
		path = os.Getenv("CONFIG_PATH")
	}
	if path == "" {
		path = "config.yaml"
	}
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open config %q: %w", path, err)
	}
	defer file.Close()

	config, err := decodeConfig(file)
	if err != nil {
		return Config{}, fmt.Errorf("parse config %q: %w", path, err)
	}
	return config, nil
}

func (config Config) Validate() error {
	switch config.Server.Host {
	case "127.0.0.1", "localhost", "::1":
	default:
		return fmt.Errorf("server.host must be a loopback address")
	}
	if config.Server.Port < 1 || config.Server.Port > 65535 {
		return fmt.Errorf("server.port must be between 1 and 65535")
	}
	if strings.TrimSpace(config.Server.Schedule) == "" {
		return fmt.Errorf("server.schedule is required")
	}
	if _, err := parseSchedule(config.Server.Schedule); err != nil {
		return fmt.Errorf("invalid cron schedule: %w", err)
	}
	if strings.TrimSpace(config.GitHub.TokenEnv) == "" {
		return fmt.Errorf("github.tokenEnv is required")
	}
	if config.GitHub.MaxPages < 1 {
		return fmt.Errorf("github.maxPages must be at least 1")
	}
	if config.Rules == nil {
		return fmt.Errorf("rules must be an array")
	}
	for i, rule := range config.Rules {
		if strings.TrimSpace(rule.Name) == "" {
			return fmt.Errorf("rules[%d].name is required", i)
		}
		if strings.TrimSpace(rule.When) == "" {
			return fmt.Errorf("rules[%d].when is required", i)
		}
		if rule.Actions == nil {
			return fmt.Errorf("rules[%d].actions must be an array", i)
		}
		for j, action := range rule.Actions {
			switch action.Type {
			case "read", "done", "unsubscribe", "unread":
			default:
				return fmt.Errorf("rules[%d].actions[%d] has unknown type %q", i, j, action.Type)
			}
		}
	}
	return nil
}

func parseSchedule(schedule string) (cron.Schedule, error) {
	parser := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
	return parser.Parse("CRON_TZ=UTC " + schedule)
}

func decodeConfig(reader io.Reader) (Config, error) {
	var config Config
	decoder := yaml.NewDecoder(reader)
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return Config{}, err
	}
	return config, config.Validate()
}
