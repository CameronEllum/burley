# Repository Agent Guidelines

- Commit and push to `origin` and `github` on each completed, atomic feature change or bug fix.
- Keep commits focused on a single logical change with clear commit messages; do not bundle unrelated features or fixes into one commit.
- Verify the relevant tests/builds pass before committing (`go test ./...`, `npm run check`, `npm run build` as applicable).
