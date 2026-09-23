package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/luxass/github-notifications/internal/app"
	"github.com/luxass/github-notifications/internal/github"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("Service stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	config, err := app.LoadConfig(os.Getenv("CONFIG_PATH"))
	if err != nil {
		return err
	}
	token := strings.TrimSpace(os.Getenv(config.GitHub.TokenEnv))
	if token == "" {
		return fmt.Errorf("environment variable %s is required", config.GitHub.TokenEnv)
	}

	client := github.NewClient(token, &http.Client{Timeout: 30 * time.Second})
	poller, err := app.NewPoller(config, client, logger)
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/" {
			http.NotFound(writer, request)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]string{"name": "github-notifications", "status": "ok"})
	})
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": "healthy"})
	})

	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", config.Server.Host, config.Server.Port),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go poller.Run(ctx)

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("HTTP server listening", "address", server.Addr)
		err := server.ListenAndServe()
		if !errors.Is(err, http.ErrServerClosed) {
			serverErrors <- err
		}
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-serverErrors:
		return err
	}
}

func writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(body); err != nil {
		slog.Error("Write HTTP response", "error", err)
	}
}
