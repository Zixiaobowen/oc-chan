import type { RendererContext, RendererContribution } from '../types'
import EventsView from '../../EventsView'
import { Sources } from '../../components'
function Page(context: RendererContext) { return context.events ? <EventsView {...context.events} /> : null }
const contribution: RendererContribution = { id: 'events', section: 'events', retainWhenDisabled: true, Page, Source: Sources }
export default contribution
