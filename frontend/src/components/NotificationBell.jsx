import { useState, useEffect, useRef } from 'react'
import { 
  BellIcon,
  XMarkIcon,
  CheckIcon,
  TrashIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  BuildingStorefrontIcon,
  ArchiveBoxIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline'
import { notificationsAPI } from '../services/api'
import toast from 'react-hot-toast'
import { useI18n } from '../contexts/I18nContext'
import { Link } from 'react-router-dom'
import { useShell } from './shell/ShellContext'

/** A notification from Simeli's watch carries the record to open and the question to ask. */
function watchOf(n) {
  let d = n?.data
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = null } }
  return d && d.kind === 'simeli_watch' ? d : null
}

function NotificationBell() {
  const { t } = useI18n()
  const { openSimeli } = useShell()
  const [isOpen, setIsOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    fetchUnreadCount()
    
    // Fetch count every 30 seconds
    const interval = setInterval(fetchUnreadCount, 30000)
    
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (isOpen) {
      fetchNotifications()
      // Opening the panel counts as having seen its contents, so the badge
      // stops feeling stuck at a stale number while the user browses the
      // app. Mark-all-read here is the "seen" signal (the user asked for
      // exactly this: auto-decrement on open, not only via the explicit
      // mark-all button or per-item clicks). New notifications arriving
      // afterwards bump the badge again as usual.
      notificationsAPI.markAllAsRead()
        .then(() => setUnreadCount(0))
        .catch(() => { /* non-fatal: badge refreshes on the next poll */ })
    }
  }, [isOpen])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const fetchUnreadCount = async () => {
    try {
      const response = await notificationsAPI.getUnreadCount()
      setUnreadCount(response.data.data.count)
    } catch (error) {
      // Silently fail for unread count
      console.error('Error fetching unread count:', error)
    }
  }

  const fetchNotifications = async () => {
    setIsLoading(true)
    try {
      const response = await notificationsAPI.getAll({ limit: 20 })
      setNotifications(response.data.data)
    } catch (error) {
      toast.error(t('ui.failedToFetchNotifications'))
      console.error('Error fetching notifications:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleMarkAsRead = async (notificationId) => {
    try {
      await notificationsAPI.markAsRead(notificationId)
      setNotifications(prev => 
        prev.map(n => 
          n.id === notificationId ? { ...n, is_read: true, read_at: new Date() } : n
        )
      )
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (error) {
      toast.error(t('ui.failedToMarkNotificationAsRead'))
      console.error('Error marking notification as read:', error)
    }
  }

  const handleMarkAllAsRead = async () => {
    try {
      await notificationsAPI.markAllAsRead()
      setNotifications(prev => 
        prev.map(n => ({ ...n, is_read: true, read_at: new Date() }))
      )
      setUnreadCount(0)
      toast.success(t('ui.allNotificationsMarkedAsRead'))
    } catch (error) {
      toast.error(t('ui.failedToMarkAllNotificationsAsRead'))
      console.error('Error marking all notifications as read:', error)
    }
  }

  const handleDelete = async (notificationId) => {
    try {
      await notificationsAPI.delete(notificationId)
      setNotifications(prev => prev.filter(n => n.id !== notificationId))
      
      // Update unread count if deleted notification was unread
      const deletedNotification = notifications.find(n => n.id === notificationId)
      if (deletedNotification && !deletedNotification.is_read) {
        setUnreadCount(prev => Math.max(0, prev - 1))
      }
      
      toast.success(t('ui.notificationDeleted'))
    } catch (error) {
      toast.error(t('ui.failedToDeleteNotification'))
      console.error('Error deleting notification:', error)
    }
  }

  const getNotificationIcon = (type) => {
    switch (type) {
      // Item Master notifications
      case 'item_master_submitted':
        return <ClockIcon className="w-4 h-4 text-warn-500" />
      case 'item_master_approved':
      case 'ITEM_APPROVED':
        return <CheckCircleIcon className="w-4 h-4 text-ok-600" />
      case 'item_master_declined':
      case 'ITEM_DECLINED':
        return <ExclamationTriangleIcon className="w-4 h-4 text-risk-600" />
        
      // Inventory Item notifications
      case 'inventory_item_submitted':
        return <ClockIcon className="w-4 h-4 text-warn-500" />
      case 'inventory_item_approved':
        return <CheckCircleIcon className="w-4 h-4 text-ok-600" />
      case 'inventory_item_declined':
        return <ExclamationTriangleIcon className="w-4 h-4 text-risk-600" />
        
      // Storage Assignment notifications  
      case 'storage_assignment_submitted':
        return <ClockIcon className="w-4 h-4 text-warn-500" />
      case 'storage_assignment_approved':
        return <ArrowRightIcon className="w-4 h-4 text-ok-600" />
      case 'storage_assignment_declined':
        return <ExclamationTriangleIcon className="w-4 h-4 text-risk-600" />
        
      // Storage Location notifications
      case 'storage_location_submitted':
        return <ClockIcon className="w-4 h-4 text-warn-500" />
      case 'storage_location_approved':
        return <BuildingStorefrontIcon className="w-4 h-4 text-ok-600" />
      case 'storage_location_declined':
        return <ExclamationTriangleIcon className="w-4 h-4 text-risk-600" />
        
      // Bin notifications
      case 'bin_submitted':
        return <ClockIcon className="w-4 h-4 text-warn-500" />
      case 'bin_approved':
        return <ArchiveBoxIcon className="w-4 h-4 text-ok-600" />
      case 'bin_declined':
        return <ExclamationTriangleIcon className="w-4 h-4 text-risk-600" />
        
      default:
        return <ClockIcon className="w-4 h-4 text-ink-500" />
    }
  }

  const formatTimeAgo = (dateString) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInMinutes = Math.floor((now - date) / (1000 * 60))
    
    if (diffInMinutes < 1) return 'Just now'
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`
    
    const diffInHours = Math.floor(diffInMinutes / 60)
    if (diffInHours < 24) return `${diffInHours}h ago`
    
    const diffInDays = Math.floor(diffInHours / 24)
    if (diffInDays < 7) return `${diffInDays}d ago`
    
    return date.toLocaleDateString()
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label={unreadCount > 0 ? `${t('ui.notifications')}: ${unreadCount} unread` : t('ui.notifications')}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100 hover:text-fg"
      >
        <BellIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute right-0.5 top-0.5 min-w-[16px] rounded bg-ink-900 px-1 font-mono text-[10px] leading-4 text-white tabular-nums">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div role="dialog" aria-label={t('ui.notifications')} className="absolute right-0 z-50 mt-1 flex max-h-[70vh] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border border-ink-200 bg-overlay shadow-overlay animate-pop">
          <div className="flex items-center justify-between border-b border-ink-200 px-3 py-2">
            <h3 className="text-sm font-semibold text-fg">{t('ui.notifications')}</h3>
            <div className="flex items-center gap-1">
              {notifications.some(n => !n.is_read) && (
                <button type="button" onClick={handleMarkAllAsRead} className="rounded px-1.5 py-1 text-xs font-medium text-ink-600 hover:bg-ink-100 hover:text-fg">
                  {t('ui.markAllAsRead')}
                </button>
              )}
              <button type="button" onClick={() => setIsOpen(false)} aria-label="Close" className="rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-fg">
                <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto ui-scroll">
            {isLoading ? (
              <div role="status" className="space-y-3 p-3">
                <span className="sr-only">{t('ui.loadingNotifications')}</span>
                {[0, 1, 2].map((i) => <span key={i} className="skeleton block h-10 w-full" />)}
              </div>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-500">{t('ui.noNotifications')}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {notifications.map((notification) => (
                  <li key={notification.id} className={`group relative flex gap-3 px-3 py-2.5 ${!notification.is_read ? 'bg-sunken' : ''}`}>
                    {!notification.is_read && <span aria-label="Unread" className="absolute left-1 top-4 h-1.5 w-1.5 rounded-full bg-brand-600" />}
                    <span className="mt-0.5 shrink-0">{getNotificationIcon(notification.type)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fg">{notification.title}</p>
                      <p className="mt-0.5 text-sm text-ink-600">{notification.message}</p>
                      {watchOf(notification) ? (
                        <p className="mt-1 flex gap-3 text-xs">
                          {watchOf(notification).link ? <Link to={watchOf(notification).link} onClick={() => setIsOpen(false)} className="bos-link">Open</Link> : null}
                          {watchOf(notification).ask ? (
                            <button type="button" className="bos-link" onClick={() => { setIsOpen(false); openSimeli({ question: `${watchOf(notification).ask} Prepare the next step for my approval.` }) }}>Ask Simeli</button>
                          ) : null}
                        </p>
                      ) : null}
                      <p className="mt-1 font-mono text-2xs text-ink-500">{formatTimeAgo(notification.created_at)}</p>
                    </div>
                    <div className="flex shrink-0 items-start gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      {!notification.is_read && (
                        <button type="button" onClick={() => handleMarkAsRead(notification.id)} aria-label={t('ui.markAsRead')} title={t('ui.markAsRead')} className="rounded p-1 text-ink-500 hover:bg-ink-100 hover:text-fg">
                          <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                      <button type="button" onClick={() => handleDelete(notification.id)} aria-label={t('ui.delete')} title={t('ui.delete')} className="rounded p-1 text-ink-500 hover:bg-risk-50 hover:text-risk-600">
                        <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default NotificationBell
