/* Entry module. Order matters: each import runs that module's top-level definitions (dictionaries,
   registrations and component definitions) before the next one, which is why the list below is
   ordered foundational → shell → pages. It also re-exports the hooks the host loader calls. */

import './util.js'
import './style.js'
import './i18n.js'
import './markdown.js'
import './controls.js'
import './api.js'
import './widgets.js'
import './localtext.js'
import './router.js'
import './shell.js'
import './live-model.js'
import './setup.js'
import './live-ui.js'
import './overview.js'
import './source.js'
import './trigger.js'
import './thread-detail.js'
import './eval.js'
import './execution.js'
import './ticket-detail.js'
import './settings.js'

export { inject, apply } from './apply.js'
