import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { PriceRecord } from '../types'

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

  const chartData = data.map(d => ({
    ...d,
    date: formatDate(d.scraped_at),
    time: formatTime(d.scraped_at),
  }))

  const prices = data.map(d => d.price)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const padding = (maxPrice - minPrice) * 0.1 || 1
  const yMin = Math.floor(minPrice - padding)
  const yMax = Math.ceil(maxPrice + padding)

  return (
    <ResponsiveContainer width="100%" height={280}>
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
          formatter={(value: unknown) => [`$${Number(value).toFixed(2)}`, 'Price']}
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
        <Line
          type="monotone"
          dataKey="price"
          stroke="#6366f1"
          strokeWidth={2}
          dot={{ fill: '#6366f1', r: 3 }}
          activeDot={{ r: 5, fill: '#818cf8' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
