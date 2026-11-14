/* The React runtime every client module shares: the host provides `react` through the module loader's
   `require`, and this module pins the single `h` binding that JSX compiles to (jsxFactory). */

import * as ReactModule from 'react'

export const React = ReactModule.default ?? ReactModule
export const h = React.createElement
export const useState = React.useState
export const useEffect = React.useEffect
export const useLayoutEffect = React.useLayoutEffect
export const useRef = React.useRef
export const useMemo = React.useMemo
export const useCallback = React.useCallback
export const useContext = React.useContext
export const createContext = React.createContext
export const Fragment = React.Fragment
