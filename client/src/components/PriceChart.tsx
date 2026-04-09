import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'
import type { PriceRecord } from '../types'
import { buildChartData } from '../lib/chart-data'

interface Props {
  data: PriceRecord[]
  threshold?: number | null
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr.includes('Z') ? dateStr : dateStr + 'Z')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr.includes('Z') ? dateStr : dateStr + 'Z')
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function PriceChart({ data, threshold }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-sm">
        No price data yet. Trigger a check to start tracking.
      </div>
    )
  }

  const { rows, sellers, isSingleSeller } = buildChartData(data)

  // Attach display-friendly fields to each row without mutating the original.
  // recharts reads these via dataKey so they need to live on the row object.
  const chartData = rows.map(r => ({
    ...r,
    date: formatDate(String(r.scraped_at)),
    time: formatTime(String(r.scraped_at)),
  }))

  // Compute Y-axis bounds from all price values across every seller so
  // the chart shows the full spread, not just the first seller's range.
  const allPrices: number[] = []
  if (isSingleSeller) {
    for (const d of data) allPrices.push(d.price)
  } else {
    for (const row of rows) {
      for (const s of sellers) {
        const v = row[s.key]
        if (typeof v === 'number') allPrices.push(v)
      }
    }
  }
  const minPrice = Math.min(...allPrices)
  const maxPrice = Math.max(...allPrices)
  const padding = (maxPrice - minPrice) * 0.1 || 1
  const yMin = Math.floor(minPrice - padding)
  const yMax = Math.ceil(maxPrice + padding)

  // Single-seller fast path: render exactly like before multi-seller
  // existed. Preserves the look of trackers that only have one URL.
  const singleSellerDataKey = sellers.length === 1 ? sellers[0].key : 'price'
  const singleSellerColor = sellers.length === 1 ? sellers[0].color : '#6366f1'

  return (
    <ResponsiveContainer width="100%" height={isSingleSeller ? 280 : 320}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
        <XAxis
          dataKey="date"
          stroke="#64748b"
          fontSize={12}
          tickLine={false}
        />
        <YAxis
          domain={[yMin, yMax]}
          stroke="#64748b"
          fontSize={12}
          tickLine={false}
          tickFormatter={(v: number) => `$${v}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            color: '#f1f5f9',
            fontSize: '13px',
          }}
          formatter={(value: unknown, name: unknown) => {
            // `name` is the seller key from dataKey; translate it back to
            // the friendly hostname label for the tooltip.
            const seller = sellers.find(s => s.key === name)
            const label = seller?.label || 'Price'
            return [`$${Number(value).toFixed(2)}`, label]
          }}
          labelFormatter={(_label: unknown, payload: unknown) => {
            const items = payload as Array<{ payload: { time: string } }> | undefined
            return items?.[0]?.payload?.time || ''
          }}
        />
        {threshold && (
          <ReferenceLine
            y={threshold}
            stroke="#f59e0b"
            strokeDasharray="5 5"
            label={{
              value: `Target: $${threshold}`,
              fill: '#f59e0b',
              fontSize: 12,
              position: 'right',
            }}
          />
        )}
        {!isSingleSeller && (
          <Legend
            verticalAlign="bottom"
            height={32}
            iconType="circle"
            wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
            formatter={(value: unknown) => {
              // recharts passes the dataKey; translate to hostname label.
              const seller = sellers.find(s => s.key === value)
              return <span style={{ color: '#94a3b8' }}>{seller?.label ?? String(value)}</span>
            }}
          />
        )}
        {isSingleSeller ? (
          <Line
            type="monotone"
            dataKey={singleSellerDataKey}
            stroke={singleSellerColor}
            strokeWidth={2}
            dot={{ fill: singleSellerColor, r: 3 }}
            activeDot={{ r: 5, fill: '#818cf8' }}
            connectNulls
          />
        ) : (
          sellers.map(seller => (
            <Line
              key={seller.key}
              type="monotone"
              dataKey={seller.key}
              name={seller.key}
              stroke={seller.color}
              strokeWidth={2}
              dot={{ fill: seller.color, r: 3 }}
              activeDot={{ r: 5 }}
              connectNulls
            />
          ))
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}
