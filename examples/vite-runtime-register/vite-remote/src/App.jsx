import MessageCard from './MessageCard';
import { getMessage } from './message';

export default function App() {
  return (
    <main className="standalone">
      <p className="tag">Standalone remote</p>
      <h1>runtimeRemote</h1>
      <p>{getMessage()}</p>
      <MessageCard />
    </main>
  );
}
