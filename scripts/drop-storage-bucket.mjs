/**
 * Delete a Supabase Storage bucket.
 *
 *   node scripts/drop-storage-bucket.mjs <bucket> [--force]
 *
 * Through the Storage API rather than SQL, because Supabase blocks DELETE
 * on storage.buckets and storage.objects with a trigger. That block is
 * right: deleting the row removes the pointer, not the file, so the objects
 * would sit in the backing store with nothing referencing them - invisible,
 * unbilled to anyone's attention, and still full of whatever they held.
 *
 * Refuses a non-empty bucket unless --force, which empties it first.
 */
import 'dotenv/config'
import { supabaseAdmin } from '../db/supabase.js'

const [bucket] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const force = process.argv.includes('--force')

if (!bucket) {
  console.error('Usage: node scripts/drop-storage-bucket.mjs <bucket> [--force]')
  process.exit(1)
}

async function listAll(prefix = '') {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .list(prefix, { limit: 1000 })
  if (error) throw new Error(error.message)

  const files = []
  for (const entry of data ?? []) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    // A folder comes back with no id; recurse into it.
    if (entry.id === null) files.push(...(await listAll(path)))
    else files.push(path)
  }
  return files
}

async function main() {
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets()
  if (listError) throw new Error(listError.message)

  if (!buckets.some((b) => b.name === bucket)) {
    console.log(`Bucket "${bucket}" does not exist. Nothing to do.`)
    return
  }

  const files = await listAll()
  console.log(`bucket   ${bucket}`)
  console.log(`objects  ${files.length}`)

  if (files.length && !force) {
    for (const f of files.slice(0, 20)) console.log(`  ${f}`)
    if (files.length > 20) console.log(`  … and ${files.length - 20} more`)
    throw new Error(
      `"${bucket}" is not empty. Re-run with --force to delete these objects, ` +
        'or move them somewhere first.',
    )
  }

  if (files.length) {
    const { error } = await supabaseAdmin.storage.from(bucket).remove(files)
    if (error) throw new Error(`emptying failed: ${error.message}`)
    console.log(`deleted  ${files.length} object(s)`)
  }

  const { error } = await supabaseAdmin.storage.deleteBucket(bucket)
  if (error) throw new Error(`deleteBucket failed: ${error.message}`)

  console.log(`\nBucket "${bucket}" deleted.`)
}

main().catch((error) => {
  console.error('\nFAILED:', error.message)
  process.exitCode = 1
})
