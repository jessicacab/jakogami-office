import './styles/reset.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/auth.css';
import { initAuth } from './ui/auth.js';

// This entry point deliberately does not statically import the scene or employee data.
initAuth();
