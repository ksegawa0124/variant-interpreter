// 参照データ（ClinGen Dosage / Gene-Disease Validity / CSpec）を取得して src/data/generated/*.json へ変換する。
// 実行: npm run build:data（手動。更新頻度が低いため、生成物はリポジトリに同梱する。CI は取得しない）
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseCSpecDoc, parseCSpecIndex, parseDosageReleaseDate, parseDosageTsv, parseValidityCsv,
  type CSpecDoc, type DataMeta,
} from '../src/data/convert.ts'
import { fetchJson } from '../src/api/http.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'generated')
mkdirSync(OUT, { recursive: true })
const now = new Date().toISOString()

async function fetchText(url: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e}`)
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
  }
  throw new Error(`${url}: 取得失敗`)
}

const write = (name: string, obj: unknown) => {
  const s = JSON.stringify(obj)
  writeFileSync(join(OUT, name), s)
  console.log(`wrote ${name}  ${(s.length / 1024).toFixed(0)} KB`)
}

// ---- Dosage ----
for (const asm of ['GRCh38', 'GRCh37'] as const) {
  for (const kind of ['gene', 'region'] as const) {
    const url = `https://ftp.clinicalgenome.org/ClinGen_${kind}_curation_list_${asm}.tsv`
    const text = await fetchText(url)
    const entries = parseDosageTsv(text)
    const meta: DataMeta = {
      source: `ClinGen Dosage Sensitivity (${kind})`, url, fetchedAt: now,
      version: parseDosageReleaseDate(text), assembly: asm, count: entries.length,
    }
    write(`dosage-${kind}-${asm}.json`, { meta, entries })
  }
}

// ---- Gene-Disease Validity ----
{
  const url = 'https://search.clinicalgenome.org/kb/gene-validity/download'
  const { byGene, fileDate } = parseValidityCsv(await fetchText(url))
  const count = Object.values(byGene).reduce((n, a) => n + a.length, 0)
  const meta: DataMeta = { source: 'ClinGen Gene-Disease Validity', url, fetchedAt: now, version: fileDate, count }
  write('gene-validity.json', { meta, byGene })
}

// ---- CSpec ----
{
  const base = 'https://cspec.genome.network/cspec/api'
  const index = parseCSpecIndex(await fetchJson<unknown>(`${base}/svis`, { timeoutMs: 60000 }))
  const released = index.filter((e) => e.status === 'Released')
  console.log(`CSpec: ${index.length} specs, ${released.length} released`)
  const docs: CSpecDoc[] = []
  const queue = [...released]
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        docs.push(parseCSpecDoc(await fetchJson<unknown>(`${base}/SequenceVariantInterpretation/id/${e.id}`, { timeoutMs: 60000 })))
      } catch (err) {
        console.warn(`  skip ${e.id}: ${err}`)
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  docs.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  const byGene: Record<string, string[]> = {}
  for (const d of docs) {
    for (const rs of d.ruleSets) {
      for (const g of rs.genes) {
        const ids = (byGene[g] ??= [])
        if (!ids.includes(d.id)) ids.push(d.id)
      }
    }
  }
  const meta: DataMeta = {
    source: 'ClinGen CSpec Registry', url: `${base}/svis`, fetchedAt: now,
    version: docs.map((d) => d.lastUpdated).sort().at(-1)?.slice(0, 10) ?? null, count: docs.length,
  }
  write('cspec.json', { meta, byGene, specs: docs })
}
