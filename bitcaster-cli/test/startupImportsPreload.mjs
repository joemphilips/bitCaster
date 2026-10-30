// Cheap CLI command registration must not evaluate unrelated native actions.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@bitcaster-market/client-sdk')
      throw new Error('CLI startup evaluated the whole SDK export graph from ' + context.parentURL)
    const resolved = nextResolve(specifier, context)
    if (
      /\/bitcaster-daemon\/(?:src|dist)\/(?:nativeSignerProfile|nativeBookmarks|nativeSettings)\.(?:ts|js)$/.test(
        resolved.url,
      )
    )
      throw new Error('CLI startup evaluated an unrelated native action')
    return resolved
  },
})
