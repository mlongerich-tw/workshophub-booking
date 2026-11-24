SHELL := /bin/bash
ROOT_DIR := $(shell pwd)
API_DIR := $(ROOT_DIR)/api

.PHONY: setup dev test test-unit lint format-check build seed reset-db smoke-test security prod-up prod-down prod-logs sync-opencode check-opencode branch-check reasons-lint

## setup: Install dependencies, generate Prisma client, push schema, seed database
setup:
	pnpm install
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example"; fi
	@cp .env $(API_DIR)/.env
	cd $(API_DIR) && pnpm exec prisma generate
	cd $(API_DIR) && pnpm exec prisma db push
	$(MAKE) seed
	@echo "Setup complete. Run 'make dev' to start."

## dev: Start frontend and backend in development mode
dev:
	pnpm run dev

## test: Run all tests (unit + integration)
test:
	pnpm run test

## test-unit: Run unit tests only (no database required)
test-unit:
	cd $(API_DIR) && pnpm run test:unit

## lint: Run ESLint on all packages
lint:
	pnpm run lint

## format-check: Check Prettier formatting on all packages
format-check:
	pnpm run format-check

## build: Build frontend and backend
build:
	pnpm run build

## branch-check: Fail unless the branch is latc-<n>-<slug> (or latc-xx-<slug> for tooling work)
##   Checks the current branch; the pre-push hook passes BRANCH_CHECK_ARGS=--pre-push
branch-check:
	@bash scripts/branch-name-check.sh $(BRANCH_CHECK_ARGS)

## reasons-lint: Fail unless SPDD canvases have all REASONS sections, and story source changes have a canvas
##   Lints the working copy; hooks pass REASONS_LINT_ARGS=--staged (pre-commit) or --pre-push (pre-push)
reasons-lint:
	@bash scripts/reasons-lint.sh $(REASONS_LINT_ARGS)

## sync-opencode: Regenerate the OpenCode config from the Claude setup (Claude is the source of truth)
sync-opencode:
	node scripts/sync-opencode.mjs

## check-opencode: Fail if the OpenCode config has drifted from the Claude setup
check-opencode:
	node scripts/sync-opencode.mjs --check

## seed: Seed the SQLite database with sample data
seed:
	cd $(API_DIR) && pnpm exec prisma db seed

## reset-db: Reset and re-seed the SQLite database
reset-db:
	cd $(API_DIR) && pnpm exec prisma db push --force-reset
	$(MAKE) seed

## smoke-test: Run smoke tests against a running application
smoke-test:
	@bash scripts/smoke-test.sh

## security: Run local security checks (Gitleaks + Trivy)
security:
	@bash scripts/security.sh

## prod-up: Start production-like environment with Docker Compose
prod-up:
	docker compose -f docker-compose.prod.yml up -d --build
	@echo "Production environment started. Run 'make smoke-test' to verify."

## prod-down: Stop production-like environment
prod-down:
	docker compose -f docker-compose.prod.yml down

## prod-logs: Show production environment logs
prod-logs:
	docker compose -f docker-compose.prod.yml logs

help:
	@grep -E '^## ' Makefile | sed 's/^## /  /'
