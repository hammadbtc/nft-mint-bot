#!/bin/bash
set -e

echo "🔄 Waiting for DATABASE_URL..."
for i in $(seq 1 30); do
  if [ -n "$DATABASE_URL" ]; then
    echo "✅ DATABASE_URL found"
    break
  fi
  echo "   Waiting for DATABASE_URL... ($i/30)"
  sleep 2
done

if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL not set after 60s — continuing anyway"
fi

echo "📦 Pushing schema to PostgreSQL..."
npx drizzle-kit push 2>&1 || echo "⚠️  drizzle-kit push failed — continuing (DB may already be synced)"

echo "🚀 Starting Next.js..."
exec node_modules/.bin/next start
