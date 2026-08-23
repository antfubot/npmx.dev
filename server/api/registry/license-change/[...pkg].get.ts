import { compare, isPrerelease, isStable } from 'verkit'
import { normalizeLicense } from '#shared/utils/npm'

interface LicenseChangeRecord {
  from: string
  to: string
}

/**
 * The previous version in semver order (not publish time), so back-ported
 * releases don't produce misleading cross-line license diffs. Mirrors the
 * install-size callout: pre-releases compare against the highest stable below
 * them; stable versions compare against the previous stable.
 */
function getSemverComparisonVersion(stableVersions: string[], target: string): string | null {
  if (isPrerelease(target)) {
    return stableVersions.findLast(v => compare(v, target) < 0) ?? null
  }
  const currentIndex = stableVersions.indexOf(target)
  return currentIndex > 0 ? (stableVersions[currentIndex - 1] ?? null) : null
}

export default defineCachedEventHandler(
  async event => {
    // 1. Extract the package name from the catch-all parameter
    const packageName = getRouterParam(event, 'pkg')
    if (!packageName) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Package name is required',
      })
    }
    const query = getQuery(event)
    const version = query.version || 'latest'

    try {
      // 2. Fetch the "Packument" on the server
      // This stays on the server, so the client never downloads this massive JSON
      const data = await fetchNpmPackage(packageName)

      if (!data.versions || !data.time) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Package metadata not found',
        })
      }
      // 3. Process the logic — compare against the previous version in semver order
      const stableVersions = Object.keys(data.versions)
        .filter(v => data.time[v] && isStable(v))
        .sort(compare)

      const targetVersion =
        version === 'latest' ? (data['dist-tags']?.latest ?? stableVersions.at(-1)) : String(version)

      let change: LicenseChangeRecord | null = null

      const comparisonVersion = targetVersion
        ? getSemverComparisonVersion(stableVersions, targetVersion)
        : null

      // Skip when there's no real previous version, else we'd diff against a phantom 'UNKNOWN'.
      if (targetVersion && comparisonVersion) {
        const currentLicense = normalizeLicense(data.versions[targetVersion]?.license) ?? 'UNKNOWN'
        const previousLicense =
          normalizeLicense(data.versions[comparisonVersion]?.license) ?? 'UNKNOWN'

        if (currentLicense !== previousLicense) {
          change = {
            from: previousLicense,
            to: currentLicense,
          }
        }
      }
      return { change }
    } catch (error: any) {
      throw createError({
        statusCode: error.statusCode || 500,
        statusMessage: `Failed to fetch license data: ${error.message}`,
      })
    }
  },
  {
    // 5. Cache Configuration
    maxAge: 60 * 60, // time in seconds
    swr: true,
    getKey: event => {
      const pkg = getRouterParam(event, 'pkg') ?? ''
      const query = getQuery(event)

      // 1. remove the /'s from the package name
      const cleanPkg = pkg.replace(/\/+$/, '').trim()

      // 2. Get the version (default to 'latest' if not provided)
      const version = query.version || 'latest'

      // 3. Create a unique string such that it takes into account the pckage name and version
      // sample result: "license-change:v1:faker:2.1.15"
      return `license-change:v3:${cleanPkg}:${version}`
    },
  },
)
