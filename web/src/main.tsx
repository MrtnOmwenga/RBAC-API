import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './Landing';
import { Pane } from './Pane';
import { Room } from './Room';
import { loadSession } from './session';
import './styles.css';

// One app, three views: the landing page, the room (four panes), and a single pane. Each pane is
// its own page in an iframe, with its own token, editor state and WebSocket, like four laptops.
const params = new URLSearchParams(location.search);
const pane = params.get('pane');
const session = loadSession();

function App() {
  if (pane && session) return <Pane session={session} characterKey={pane} />;
  if (session && params.has('room')) return <Room session={session} />;
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
