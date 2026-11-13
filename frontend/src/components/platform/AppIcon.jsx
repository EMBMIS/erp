/**
 * An application's icon.
 *
 * Applications name their icon as a string — a native manifest picks one, and
 * a generated specification's `icon` comes from whatever the designer or the
 * model chose. Neither is a component reference, and neither can be trusted to
 * be a name this frontend has heard of.
 *
 * So this is a lookup with a real fallback rather than a switch that throws.
 * An application whose icon nobody recognises still gets an icon and still
 * appears in the launcher; the alternative is that a capability somebody built
 * this morning renders as a blank square or crashes the grid it is in.
 */

import React from 'react'
import {
  ChartBarIcon, BuildingStorefrontIcon, ShoppingCartIcon, ArchiveBoxIcon,
  WrenchScrewdriverIcon, UserGroupIcon, UserIcon, ClipboardDocumentListIcon,
  ShieldCheckIcon, CheckBadgeIcon, TruckIcon, Squares2X2Icon, CubeIcon,
  DocumentTextIcon, BanknotesIcon, SparklesIcon, MapIcon, BeakerIcon,
  ClipboardDocumentCheckIcon, BriefcaseIcon, EnvelopeIcon,
} from '@heroicons/react/24/outline'

const ICONS = {
  'chart-bar': ChartBarIcon,
  'building-storefront': BuildingStorefrontIcon,
  'shopping-cart': ShoppingCartIcon,
  'archive-box': ArchiveBoxIcon,
  'wrench-screwdriver': WrenchScrewdriverIcon,
  'user-group': UserGroupIcon,
  user: UserIcon,
  'clipboard-document-list': ClipboardDocumentListIcon,
  'clipboard-list': ClipboardDocumentListIcon,
  'clipboard-check': ClipboardDocumentCheckIcon,
  'shield-check': ShieldCheckIcon,
  'badge-check': CheckBadgeIcon,
  truck: TruckIcon,
  'layout-grid': Squares2X2Icon,
  cube: CubeIcon,
  'document-text': DocumentTextIcon,
  banknotes: BanknotesIcon,
  sparkles: SparklesIcon,
  map: MapIcon,
  beaker: BeakerIcon,
  briefcase: BriefcaseIcon,
  envelope: EnvelopeIcon,
}

export default function AppIcon({ name, className = 'h-5 w-5' }) {
  const Icon = ICONS[name] || Squares2X2Icon
  return <Icon className={className} aria-hidden="true" />
}
