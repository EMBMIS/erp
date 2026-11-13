import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from './AuthContext'

/**
 * The company the user is currently acting for.
 *
 * The selected company id is kept in localStorage because the axios request
 * interceptor reads it there — an interceptor cannot subscribe to React state,
 * and threading the header through every call site is exactly the kind of
 * omission that shows one company's data on a screen that forgot it.
 *
 * Switching companies reloads rather than re-rendering. Every list, cache and
 * open form in the app holds data belonging to the previous company, and a
 * partial refresh would leave some of it on screen next to the new company's
 * data with no way to tell which is which. A reload is blunt and correct.
 */

const CompanyContext = createContext(null)

export const useCompany = () => {
  const context = useContext(CompanyContext)
  if (!context) {
    throw new Error('useCompany must be used within a CompanyProvider')
  }
  return context
}

const STORAGE_KEY = 'qira.companyId'

export const CompanyProvider = ({ children }) => {
  const { isAuthenticated } = useAuth()
  const [companies, setCompanies] = useState([])
  const [current, setCurrent] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/companies/mine')
      const list = data?.data || []
      setCompanies(list)

      const storedId = localStorage.getItem(STORAGE_KEY)
      // A stored id that is no longer in the list (access revoked, company
      // deactivated) must not be kept — it would be sent on every request and
      // rejected. Fall back to the default rather than leaving the app wedged.
      const active = list.find((c) => c.id === storedId)
        || list.find((c) => c.is_primary)
        || list.find((c) => c.is_default)
        || list[0]
        || null

      if (active) {
        setCurrent(active)
        localStorage.setItem(STORAGE_KEY, active.id)
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch (error) {
      // Single-company installations that have not run the multi-company
      // migrations have no such endpoint. That is not an error worth showing.
      console.debug('Company list unavailable:', error?.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAuthenticated) load()
  }, [isAuthenticated, load])

  const switchCompany = useCallback((companyId) => {
    if (!companyId || companyId === current?.id) return
    localStorage.setItem(STORAGE_KEY, companyId)
    window.location.reload()
  }, [current])

  return (
    <CompanyContext.Provider
      value={{
        companies,
        current,
        loading,
        // True only where there is genuinely a choice to make; the switcher
        // hides itself rather than showing a dropdown with one entry.
        isMultiCompany: companies.length > 1,
        currency: current?.base_currency || 'USD',
        locale: current?.locale || null,
        switchCompany,
        reload: load,
      }}
    >
      {children}
    </CompanyContext.Provider>
  )
}

export default CompanyContext
