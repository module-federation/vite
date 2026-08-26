import './App.css';
import reactLogo from './assets/react.svg';
import { Input } from 'antd';
import { deployInfo } from './deployInfo';
// import viteLogo from './assets/vite.svg';

function App() {
    return (
        <div className="App">
            <div>
                <a href="https://reactjs.org" target="_blank">
                    <img src={reactLogo} className="logo react" alt="React logo" />
                </a>
            </div>
            <h2>Vite + React</h2>
            <div className="card">
                <p>
                    Edit <code>src/App.jsx</code> and save to test HMR
                </p>
                <p>The remote statically imports only the Ant Design Input component.</p>
                <Input placeholder="Remote Input" />
                <p data-testid="remote-deploy-info">{deployInfo}</p>
            </div>
        </div>
    );
}

export default App;
