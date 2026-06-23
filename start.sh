#!/bin/bash
# ============================================
# Exam Supervisor System - Install & Run Script
# ============================================

set -e

echo "========================================="
echo "  نظام توزيع لجان الإشراف على الامتحانات"
echo "  Exam Supervisor System - Installer"
echo "========================================="
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "[1/5] Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
else
    echo "[1/5] Bun already installed ✓"
fi

echo "[2/5] Installing dependencies..."
bun install

echo "[3/5] Setting up database..."
mkdir -p db
bun run db:push

echo "[4/5] Building project for production..."
bun run build

echo "[5/5] Starting server..."
echo ""
echo "========================================="
echo "  Server starting on http://localhost:3000"
echo "  Admin password: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo "========================================="
echo ""

bun run start