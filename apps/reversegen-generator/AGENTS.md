# ReverseGen generator deployment package

This directory documents the deployment boundary for the ReverseGen main
generator page. The build entry points are the repository-root `Dockerfile`
and `.dockerignore`.

Do not modify, regenerate, or move files in this directory unless the user
explicitly asks to change the generator deployment, packaging, container,
iframe integration, or this app directory itself.

Normal GUI, algorithm, strategy, analysis, test, and documentation work outside
this deployment scope must leave this directory unchanged.

When this package is intentionally changed, verify:

- the image builds from the repository root;
- `GET /health` succeeds;
- the configured `APP_BASE_PATH` serves the main page;
- the main page can load a level and generate a board;
- `POST /api/v1/generate-replay` accepts the copied parameter string and level JSON.
