#!/bin/bash
# Quick dev mode start (no build needed)
set -e

echo "Starting Exam Supervisor System (Dev Mode)..."
echo "Server: http://localhost:3000"
echo "Admin password: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo ""

mkdir -p db
bun run db:push 2>/dev/null
bun run dev