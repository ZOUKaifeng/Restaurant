import { createRoot } from 'react-dom/client';
import App from './App';
import { readRoute } from './routing';
import './styles.css';

// 先清理动作链接，再挂载应用和执行账户请求。
const route = readRoute();
const root = document.getElementById('root');
if (!root) throw new Error('缺少应用挂载节点');
createRoot(root).render(<App initialRoute={route} />);
