import { mount } from 'svelte'
import 'katex/dist/katex.min.css'
import './app.css'
import App from './App.svelte'
import { applyTheme, storedThemeMode } from './lib/theme'

// Apply the saved theme before the first paint to avoid a light flash.
applyTheme(storedThemeMode())

const target = document.getElementById('app')
if (!target) throw new Error('Missing #app mount point')

const app = mount(App, { target })

export default app
