import { defineCollection, z } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Second motto. The landing hero draws it as the reflection of the title in water.
        heroReflection: z.string().optional(),
      }),
    }),
  }),
}
