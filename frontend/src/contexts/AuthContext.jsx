import React, { createContext, useContext, useState, useEffect } from 'react'
import { authAPI } from '../services/api'

const AuthContext = createContext(null)

// Shared with CompanyContext.jsx's STORAGE_KEY. A company id picked under one
// account must never survive into another — the axios interceptor sends it on
// every request regardless of whose token is active, and a stale id from a
// previous session gets flatly refused by establishCompany (auth.js) rather
// than falling back, which otherwise wedges the new session in a permanent
// verify-fails -> logout -> verify-fails loop.
const COMPANY_STORAGE_KEY = 'qira.companyId'

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    initializeAuth()
  }, [])

  const initializeAuth = async () => {
    try {
      const token = localStorage.getItem('token')
      const storedUser = localStorage.getItem('user')
      
      if (token && storedUser) {
        // Verify token is still valid
        const response = await authAPI.verifyToken()
        if (response.data.success) {
          setUser(response.data.data.user)
          setIsAuthenticated(true)
        } else {
          logout()
        }
      } else {
        // No local token — the visitor may have logged in from the other app
        // on the same origin (embmis-web landing page via Google), which sets
        // the shared embmis_sso cookie but not this app's localStorage.
        // /auth/session mints a fresh JWT from that cookie, same shape as
        // /login; picking it up here is what makes "logged in on the landing
        // page" actually carry into the ERP instead of showing the login form.
        await trySsoSession()
      }
    } catch (error) {
      console.error('Auth initialization failed:', error)
      // Only a real rejection from the server (bad/expired token, revoked
      // company access) means the session is actually invalid. A request that
      // never got a response — the backend restarting, a dropped connection —
      // says nothing about the token, and logging out here would just bounce
      // a legitimately signed-in user back to the login screen on a reload
      // that happened to race a network hiccup.
      //
      // The same goes for answers that are not about the token at all: 429
      // (rate limited) and 5xx. Logging out on those turned a busy minute into
      // every user being thrown back to the login screen. Keep the stored
      // session; the next request tries again.
      const status = error.response?.status
      if (status === 401 || status === 403) {
        logout()
      } else {
        const storedUser = localStorage.getItem('user')
        if (storedUser) {
          try {
            setUser(JSON.parse(storedUser))
            setIsAuthenticated(true)
          } catch {
            // unreadable stored user: stay signed out
          }
        }
      }
    } finally {
      setLoading(false)
    }
  }

  // Best-effort SSO pickup from the shared cookie. Never throws: a 401 or a
  // network hiccup just means "no usable session", which is the state we
  // were already in.
  const trySsoSession = async () => {
    try {
      const response = await authAPI.session()
      const { user: ssoUser, token: ssoToken } = response.data?.data || {}
      if (ssoUser && ssoToken) {
        applySession(ssoUser, ssoToken)
      }
    } catch {
      // no session — stay logged out
    }
  }

  // Shared by every path that ends in "the browser now holds a session":
  // password login, Google login, and register/registerCompany's own
  // immediate-sign-in case below. Centralized so the same fresh-account
  // company-id purge (see COMPANY_STORAGE_KEY's own comment, top of file)
  // can't be forgotten on one of the three call sites.
  const applySession = (userData, token) => {
    localStorage.removeItem(COMPANY_STORAGE_KEY)
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(userData))

    setUser(userData)
    setIsAuthenticated(true)
  }

  const login = async (credentials) => {
    try {
      const response = await authAPI.login(credentials)
      const { user: userData, token } = response.data.data
      applySession(userData, token)
      return { success: true, user: userData }
    } catch (error) {
      console.error('Login failed:', error)
      return {
        success: false,
        error: error.response?.data?.error || 'Login failed',
        code: error.response?.data?.code,
      }
    }
  }

  // "Sign in with Google" — credential is the signed ID token from
  // useGoogleSignIn/GIS. Same response shape as login() (routes/auth.js's
  // buildAuthPayload), so it slots into the exact same session-apply path.
  const loginWithGoogle = async (credential) => {
    try {
      const response = await authAPI.googleLogin(credential)
      const { user: userData, token } = response.data.data
      applySession(userData, token)
      return { success: true, user: userData }
    } catch (error) {
      console.error('Google login failed:', error)
      return {
        success: false,
        error: error.response?.data?.error || 'Google sign-in failed',
      }
    }
  }

  const register = async (userData) => {
    try {
      const response = await authAPI.register(userData)
      const { user: newUser, token, email, requiresVerification } = response.data.data

      // register/register-company no longer issue a token — the account
      // exists but cannot sign in until the verification email is clicked
      // (EMAIL_NOT_VERIFIED in AuthContext's login()/backend routes/auth.js).
      if (requiresVerification) {
        return { success: true, requiresVerification: true, email }
      }

      applySession(newUser, token)

      return { success: true, user: newUser }
    } catch (error) {
      console.error('Registration failed:', error)
      return {
        success: false,
        error: error.response?.data?.error || 'Registration failed'
      }
    }
  }

  // Self-service signup: a brand-new company and its first (admin) user,
  // created together — distinct from register() above, which only ever joins
  // the single existing default company.
  const registerCompany = async (data) => {
    try {
      const response = await authAPI.registerCompany(data)
      const { user: newUser, token, email, requiresVerification } = response.data.data

      if (requiresVerification) {
        return { success: true, requiresVerification: true, email }
      }

      applySession(newUser, token)

      return { success: true, user: newUser }
    } catch (error) {
      console.error('Company registration failed:', error)
      return {
        success: false,
        error: error.response?.data?.error || 'Company registration failed'
      }
    }
  }

  const logout = async () => {
    try {
      await authAPI.logout()
    } catch (error) {
      console.error('Logout request failed:', error)
    }
    
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    localStorage.removeItem(COMPANY_STORAGE_KEY)
    setUser(null)
    setIsAuthenticated(false)
  }

  const updateProfile = async (profileData) => {
    try {
      const response = await authAPI.updateProfile(profileData)
      const updatedUser = response.data.data.user
      
      localStorage.setItem('user', JSON.stringify(updatedUser))
      setUser(updatedUser)
      
      return { success: true, user: updatedUser }
    } catch (error) {
      console.error('Profile update failed:', error)
      return { 
        success: false, 
        error: error.response?.data?.error || 'Profile update failed' 
      }
    }
  }

  const changePassword = async (passwordData) => {
    try {
      await authAPI.changePassword(passwordData)
      return { success: true }
    } catch (error) {
      console.error('Password change failed:', error)
      return { 
        success: false, 
        error: error.response?.data?.error || 'Password change failed' 
      }
    }
  }

  const value = {
    user,
    loading,
    isAuthenticated,
    login,
    loginWithGoogle,
    register,
    registerCompany,
    logout,
    updateProfile,
    changePassword,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export default AuthContext