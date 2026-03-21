interface Props {
  data: number[]
  width?: number
  height?: number
  className?: string
}

export default function Sparkline({ data, width = 80, height = 28, className = '' }: Props) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  })

  const trending = data[data.length - 1] <= data[0]
  const color = trending ? '#10b981' : '#ef4444'

  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={width}
        cy={parseFloat(points[points.length - 1].split(',')[1])}
        r="2"
        fill={color}
      />
    </svg>
  )
}
