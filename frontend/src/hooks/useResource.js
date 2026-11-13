/**
 * Data fetching, on the caching layer that was already installed.
 *
 * ===========================================================================
 * WHAT WAS WRONG
 * ===========================================================================
 * `@tanstack/react-query` is a dependency. `QueryClientProvider` wraps the app
 * with tuned defaults. `src/services/queryKeys.js` is a complete, carefully
 * commented key factory.
 *
 * `useQuery` and `useMutation` appeared exactly zero times in the codebase.
 *
 * Instead 158 of 168 pages hand-rolled the same twenty lines: a `useState` for
 * data, another for loading, another for error, a `useEffect` that fires an
 * axios call, and no cancellation. The consequences are not subtle:
 *
 *   • Every navigation refetches everything, including data fetched a second
 *     ago. A list → detail → back sequence hits the API three times.
 *   • Two components needing the same lookup issue two requests.
 *   • A slow response that resolves after the user has navigated away sets
 *     state on an unmounted component, or worse, overwrites newer data with
 *     older data because responses arrive out of order.
 *   • Every screen invents its own loading and error handling, so they are all
 *     slightly different and some are missing.
 *
 * These hooks are deliberately thin. The point is not to wrap React Query in
 * an abstraction — it is to give the 158 pages a shape that is barely more
 * work to adopt than what they already do, so the conversion is mechanical
 * rather than a redesign of each page.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'

/**
 * Unwrap this API's envelope.
 *
 * Every endpoint answers `{ success, data, error }`, and every page unwraps it
 * by hand — which is why some check `success` and some just take `data`, so a
 * failure that arrives with HTTP 200 renders as an empty list on some screens
 * and a crash on others.
 */
function unwrap(response) {
  const body = response?.data
  if (body && typeof body === 'object' && 'success' in body) {
    if (!body.success) {
      const error = new Error(body.error || 'The request did not succeed.')
      error.errorId = body.error_id
      throw error
    }
    return body.data
  }
  return body
}

/**
 * Read a resource.
 *
 * @param {Array} key       from services/queryKeys.js — same args, same key
 * @param {() => Promise} fetcher  an api.* call
 * @param {object} [options] passed to useQuery
 */
export function useResource(key, fetcher, options = {}) {
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => unwrap(await fetcher({ signal })),
    ...options,
  })

  return {
    ...query,
    // Named so a page converted from the old pattern can keep its own
    // variable names and read almost unchanged.
    data: query.data,
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  }
}

/**
 * Write, then invalidate whatever the write invalidated.
 *
 * `invalidates` is a list of query keys. Getting this wrong is the classic
 * bug of the hand-rolled version: the mutation succeeds, the server has new
 * data, and the list on screen still shows the old rows until someone reloads.
 *
 * @param {(vars) => Promise} mutator
 * @param {{invalidates?: Array<Array>, successMessage?: string,
 *          onSuccess?: Function, silent?: boolean}} options
 */
export function useResourceMutation(mutator, options = {}) {
  const queryClient = useQueryClient()
  const { invalidates = [], successMessage, onSuccess, silent = false, ...rest } = options

  return useMutation({
    mutationFn: async (variables) => unwrap(await mutator(variables)),
    onSuccess: (data, variables, context) => {
      for (const key of invalidates) {
        queryClient.invalidateQueries({ queryKey: key })
      }
      if (successMessage) toast.success(successMessage)
      onSuccess?.(data, variables, context)
    },
    onError: (error) => {
      // Errors are surfaced by default. The hand-rolled version frequently
      // swallowed them in a bare `catch`, so a save that failed looked
      // identical to one that worked until the user reloaded the page.
      if (!silent) {
        // An HTTP failure arrives as an axios error whose message is "Request
        // failed with status code 500" — true, and useless. Say what the
        // server said, and give the reference an administrator can look up.
        const data = error?.response?.data || {}
        const message = data.error || data.message || error.message || 'That action could not be completed.'
        const reference = error.errorId || data.error_id || error?.response?.headers?.['x-request-id']
        toast.error(reference ? `${message} (reference ${reference})` : message)
      }
    },
    ...rest,
  })
}

/**
 * Warm the cache for a resource the user is about to want.
 *
 * Wire it to onMouseEnter of a row: by the time the click lands, the detail
 * view usually has its data already.
 */
export function usePrefetch() {
  const queryClient = useQueryClient()
  return (key, fetcher) =>
    queryClient.prefetchQuery({
      queryKey: key,
      queryFn: async ({ signal }) => unwrap(await fetcher({ signal })),
    })
}

export { unwrap }
