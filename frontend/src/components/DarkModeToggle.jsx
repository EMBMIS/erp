// Header dark-mode switch — sun/moon, persists the choice.
import React, { useState } from 'react'
import { SunIcon, MoonIcon } from '@heroicons/react/24/outline'
import { isDark, toggleTheme } from '../utils/darkMode'

export default function DarkModeToggle({ className = '' }) {
  const [dark, setDark] = useState(isDark())
  return (
    <button
      type="button"
      onClick={() => { toggleTheme(); setDark(isDark()) }}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`inline-flex items-center justify-center p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700/60 ${className}`}
    >
      {dark ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
    </button>
  )
}
