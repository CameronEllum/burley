package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultRepoURL is Burley's public repository, used for update checks and the
// About/Settings links when Options does not override it.
const DefaultRepoURL = "https://github.com/CameronEllum/burley"

const defaultReleaseAPI = "https://api.github.com/repos/CameronEllum/burley/releases/latest"

const (
	releaseCacheTTL      = 30 * time.Minute
	releaseErrorCacheTTL = 10 * time.Minute
	releaseTimeout       = 6 * time.Second
)

// ReleaseInfo describes the newest GitHub release relative to this binary.
type ReleaseInfo struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	Name            string `json:"name,omitempty"`
	URL             string `json:"url,omitempty"`
	PublishedAt     string `json:"publishedAt,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	CheckedAt       string `json:"checkedAt,omitempty"`
	Error           string `json:"error,omitempty"`
	Repo            string `json:"repo"`
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
}

func (s *server) currentVersion() string {
	if s.opts.Version != "" {
		return s.opts.Version
	}
	return "0.0.0-dev"
}

func (s *server) repoURL() string {
	if s.opts.RepoURL != "" {
		return s.opts.RepoURL
	}
	return DefaultRepoURL
}

func (s *server) releaseAPIURL() string {
	if s.opts.ReleaseAPI != "" {
		return s.opts.ReleaseAPI
	}
	return defaultReleaseAPI
}

func (s *server) releaseCacheFresh() bool {
	if s.releaseAt.IsZero() {
		return false
	}
	ttl := releaseCacheTTL
	if s.releaseCache.Error != "" {
		ttl = releaseErrorCacheTTL
	}
	return time.Since(s.releaseAt) < ttl
}

// handleRelease reports the latest published GitHub release. Failures are
// reported in-band (HTTP 200 with an `error`) so the UI can stay quiet when the
// host is offline.
func (s *server) handleRelease(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1"

	s.releaseMu.Lock()
	defer s.releaseMu.Unlock()

	if !refresh && s.releaseCacheFresh() {
		writeJSON(w, http.StatusOK, s.releaseCache)
		return
	}

	info := ReleaseInfo{
		Current: s.currentVersion(),
		Repo:    s.repoURL(),
	}
	latest, err := fetchLatestRelease(r.Context(), s.releaseAPIURL(), info.Current)
	info.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		info.Error = err.Error()
		s.opts.Logger.Printf("release check: %v", err)
	} else {
		info.Latest = latest.TagName
		info.Name = latest.Name
		info.URL = latest.HTMLURL
		info.PublishedAt = latest.PublishedAt
		info.UpdateAvailable = isNewerVersion(latest.TagName, info.Current)
	}

	s.releaseCache = info
	s.releaseAt = time.Now()
	writeJSON(w, http.StatusOK, info)
}

func fetchLatestRelease(ctx context.Context, endpoint, current string) (githubRelease, error) {
	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return githubRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "burley/"+current)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return githubRelease{}, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		message := strings.TrimSpace(string(body))
		if message == "" {
			return githubRelease{}, fmt.Errorf("GitHub returned HTTP %d", res.StatusCode)
		}
		return githubRelease{}, fmt.Errorf("GitHub returned HTTP %d: %s", res.StatusCode, message)
	}

	var release githubRelease
	if err := json.NewDecoder(res.Body).Decode(&release); err != nil {
		return githubRelease{}, fmt.Errorf("invalid release response: %w", err)
	}
	if release.Draft || release.Prerelease || release.TagName == "" {
		return githubRelease{}, fmt.Errorf("no published release found")
	}
	return release, nil
}

// isNewerVersion reports whether `latest` is a newer semantic version than
// `current`. Tags may carry a leading "v" and a prerelease suffix.
func isNewerVersion(latest, current string) bool {
	lnums, lpre, lok := parseVersion(latest)
	cnums, cpre, cok := parseVersion(current)
	if !lok || !cok {
		return false
	}
	for i := 0; i < 3; i++ {
		if lnums[i] != cnums[i] {
			return lnums[i] > cnums[i]
		}
	}
	// Same numbers: a release outranks a prerelease; prerelease identifiers
	// compare lexically as a simple fallback.
	if lpre == "" && cpre != "" {
		return true
	}
	if lpre != "" && cpre == "" {
		return false
	}
	return lpre > cpre
}

func parseVersion(raw string) ([3]int, string, bool) {
	var nums [3]int
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(strings.TrimPrefix(value, "v"), "V")
	value = strings.TrimPrefix(value, "refs/tags/")
	if value == "" {
		return nums, "", false
	}

	pre := ""
	if idx := strings.IndexAny(value, "-+"); idx >= 0 {
		pre = value[idx+1:]
		value = value[:idx]
	}

	parts := strings.Split(value, ".")
	for i := 0; i < len(parts) && i < 3; i++ {
		n, err := strconv.Atoi(strings.TrimSpace(parts[i]))
		if err != nil {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, pre, true
}
