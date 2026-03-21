import { CheckCircle, PauseCircle, AlertCircle } from 'lucide-react'

const statusConfig = {
  active: { icon: CheckCircle, label: 'Active', className: 'text-success bg-success/10' },
  paused: { icon: PauseCircle, label: 'Paused', className: 'text-warning bg-warning/10' },
  error: { icon: AlertCircle, label: 'Error', className: 'text-danger bg-danger/10' },
}

export default function StatusBadge({ status }: { status: 'active' | 'paused' | 'error' }) {
  const config = statusConfig[status]
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.className}`}>
      <Icon className="w-3.5 h-3.5" />
      {config.label}
    </span>
  )
}
