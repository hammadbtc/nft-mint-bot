export function deploymentVersion(): string {
  const value = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "local";
  return value === "local" ? value : value.slice(0, 7);
}
