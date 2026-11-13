import { useCallback, useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { CameraIcon, StopCircleIcon, MagnifyingGlassIcon } from '@heroicons/react/20/solid'
import { inventoryItemsAPI } from '../../services/api'
import {
  PageHeader, Button, Card, Field, Input, InlineNotice, StatusBadge, Code, Num, Money, SkeletonRows, describeError,
} from '../../components/ui'

const READER_ID = 'barcode-scanner-reader'

/**
 * Barcode scanner — built for a phone or a handheld on the floor.
 *
 * Point the camera, or type / wedge-scan the code into the box and press
 * Enter. A match shows what the item is and where its stock stands; a code
 * that matches nothing says so in place.
 */
export default function BarcodeScanner() {
  const scannerRef = useRef(null)
  const inputRef = useRef(null)
  const [scanning, setScanning] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(null)
  const [problem, setProblem] = useState(null)

  const lookup = useCallback(async (code) => {
    const clean = String(code || '').trim()
    if (!clean) return
    setLoading(true)
    setNotFound(null)
    setProblem(null)
    try {
      const res = await inventoryItemsAPI.lookupBarcode(clean)
      setResult(res.data?.data || null)
    } catch (err) {
      setResult(null)
      if (err.response?.status === 404) setNotFound(clean)
      else setProblem(describeError(err).message || 'Barcode lookup failed.')
    } finally {
      setLoading(false)
    }
  }, [])

  const stopScanning = useCallback(async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop() } catch { /* already stopped */ }
      try { await scannerRef.current.clear() } catch { /* nothing to clear */ }
      scannerRef.current = null
    }
    setScanning(false)
  }, [])

  const startScanning = useCallback(async () => {
    setScanning(true)
    setProblem(null)
    const instance = new Html5Qrcode(READER_ID)
    scannerRef.current = instance
    try {
      await instance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        (decodedText) => {
          setManualCode(decodedText)
          lookup(decodedText)
          stopScanning()
        },
        () => { /* per-frame decode failure — expected constantly while aiming */ }
      )
    } catch {
      setProblem('The camera could not be opened. Allow camera access for this site, or type the code below.')
      setScanning(false)
      scannerRef.current = null
    }
  }, [lookup, stopScanning])

  useEffect(() => () => { stopScanning() }, [stopScanning])

  const records = result?.stock_records || []
  const onHand = records.reduce((s, r) => s + (Number(r.quantity) || 0), 0)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Barcode scanner" description="Scan or type a barcode to see the item and its stock." />

      <Card>
        <div className="space-y-4">
          <div id={READER_ID} className={scanning ? 'overflow-hidden rounded-md' : 'hidden'} />
          {scanning ? (
            <Button size="lg" block className="h-12" icon={StopCircleIcon} onClick={stopScanning}>Stop camera</Button>
          ) : (
            <Button size="lg" block variant="primary" className="h-12" icon={CameraIcon} onClick={startScanning}>Scan with camera</Button>
          )}

          <form onSubmit={(e) => { e.preventDefault(); lookup(manualCode) }} className="flex items-end gap-2">
            <Field label="Or enter the barcode" className="min-w-0 flex-1" id="barcode-value">
              <Input ref={inputRef} size="lg" className="h-12 font-mono" value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="Barcode" autoComplete="off" autoCapitalize="off" spellCheck={false} />
            </Field>
            <Button type="submit" size="lg" className="h-12" icon={MagnifyingGlassIcon} disabled={loading || !manualCode.trim()}>Look up</Button>
          </form>
          <p className="-mt-2 text-xs text-ink-500">A handheld scanner types into the box and presses Enter for you.</p>
        </div>
      </Card>

      {problem && <InlineNotice tone="risk" title="Lookup failed">{problem}</InlineNotice>}
      {notFound && (
        <InlineNotice tone="warn" title="No item has this barcode" action={<Button size="sm" variant="ghost" onClick={() => { setNotFound(null); setManualCode(''); inputRef.current?.focus() }}>Scan another</Button>}>
          <Code>{notFound}</Code> is not on any item. Check the label, or add the barcode to the item.
        </InlineNotice>
      )}
      {loading && <Card><SkeletonRows rows={3} columns={2} /></Card>}

      {result && !loading && (
        <Card
          eyebrow={<Code>{result.barcode}</Code>}
          title={result.name}
          description={[result.item_code, result.category].filter(Boolean).join(' · ')}
          actions={result.item_master_id ? <Button size="sm" to={`/inventory/items?item_master_id=${result.item_master_id}`}>View in inventory</Button> : null}
          padded={false}
        >
          {result.description && <p className="border-b border-ink-100 px-4 py-3 text-sm text-ink-700">{result.description}</p>}
          <div className="flex items-baseline justify-between px-4 pt-3">
            <h3 className="label-mono">Stock</h3>
            {records.length > 0 && <span className="text-sm text-ink-600">On hand <Num value={onHand} className="font-semibold text-fg" /></span>}
          </div>
          {records.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-600">No stock records for this item yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {records.map((r) => (
                <li key={r.id} className="flex min-h-[48px] items-center gap-3 px-4 py-2.5 text-sm">
                  <Num value={r.quantity} className="w-16 text-right text-base font-medium" />
                  <span className="min-w-0 flex-1 text-ink-600">Grade {r.condition_grade || '—'}</span>
                  <span className="text-right">{r.unit_price != null ? <Money amount={r.unit_price} currency={r.currency} /> : '—'}</span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
