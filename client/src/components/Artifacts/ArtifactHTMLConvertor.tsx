export const convertToHTML = async (content, fileName) => {
  const componentName = extractComponentName(content, fileName);
  const cleanedCode = basicCodeClean(content);
  const imports = extractImports(content);

  const htmlContent = createBasicHTML(componentName, cleanedCode, imports);

  return {
    html: htmlContent,
    componentName,
    fileName: componentName,
    success: true,
  };
};

function extractComponentName(content, fileName) {
  const patterns = [
    /export\s+default\s+function\s+(\w+)/,
    /export\s+default\s+(\w+)/,
    /function\s+(\w+)\s*\(/,
    /const\s+(\w+)\s*=\s*\(/,
    /const\s+(\w+)\s*=\s*\w+\.forwardRef/,
    /class\s+(\w+)/
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1] && !isReservedKeyword(match[1])) {
      return match[1];
    }
  }

  if (fileName) {
    const nameFromFile = fileName.replace(/\.(jsx?|tsx?)$/, '').replace(/[^a-zA-Z0-9]/g, '');
    if (nameFromFile && !isReservedKeyword(nameFromFile)) {
      return nameFromFile.charAt(0).toUpperCase() + nameFromFile.slice(1);
    }
  }

  return 'MyComponent';
}

function extractImports(content) {
  const imports = [];
  const importRegex =
    /import\s+(?:(?:(\w+)|{\s*([^}]+)\s*}|\*\s+as\s+(\w+))\s+from\s+)?['"]([^'"]+)['"];?/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const [fullMatch, defaultImport, namedImports, namespaceImport, moduleName] = match;

    imports.push({
      module: moduleName,
      default: defaultImport,
      named: namedImports ? namedImports.split(',').map((name) => name.trim()) : [],
      namespace: namespaceImport,
      raw: fullMatch,
    });
  }
  
  return imports;
}

function isReservedKeyword(word) {
  const reserved = [
    'function',
    'const',
    'class',
    'let',
    'var',
    'if',
    'else',
    'for',
    'while',
    'do',
    'return',
  ];
  return reserved.includes(word.toLowerCase());
}

function basicCodeClean(content) {
  return content
    .replace(/import[^\n]*\n/g, '')
    .replace(/export\s+(default\s+)?/g, '')
    .replace(/:\s*React\.FC[^\n]*/g, '')
    .replace(/:\s*JSX\.Element/g, '')
    .trim();
}

function createBasicHTML(componentName, cleanedCode, imports) {
  const mockGenerators = generateMocks(imports);
  
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${componentName}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="React Component: ${componentName}">
    
    <!-- Load Tailwind CSS from CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            margin: 0; 
            padding: 0; 
            background: #f8fafc;
            color: #1e293b;
        }
        
        .page-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            margin-bottom: 0;
        }
        
        .page-title {
            font-size: 2rem;
            font-weight: 700;
            margin: 0;
            text-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        
        .page-subtitle {
            color: rgba(255,255,255,0.9);
            font-size: 1rem;
            margin: 0.5rem 0 0 0;
            font-weight: 400;
        }
        
        #root {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            min-height: calc(100vh - 120px);
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            border-radius: 8px 8px 0 0;
            overflow: hidden;
        }
        
        .error {
            background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
            color: #dc2626;
            padding: 2rem;
            margin: 2rem;
            border-radius: 8px;
            border-left: 4px solid #dc2626;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
        }
        
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: #6b7280;
        }
    </style>
</head>
<body>
    <div id="root">
        <div class="loading">
            <p>Loading React component...</p>
        </div>
    </div>

    <script type="text/babel">
        const React = window.React;
        const ReactDOM = window.ReactDOM;
        const { useState, useEffect, useRef, useCallback, useMemo, useContext, createContext, 
                useReducer, forwardRef, memo, Fragment, Component, PureComponent } = React;
        
        // Common utility functions
        const getStatusColor = (status) => {
            const colors = {
                active: '#22c55e', inactive: '#ef4444', pending: '#f59e0b',
                success: '#22c55e', error: '#ef4444', warning: '#f59e0b', 
                info: '#3b82f6', default: '#6b7280'
            };
            return colors[status] || colors.default;
        };
        
        const formatDate = (date) => {
            if (!date) return '';
            try { return new Date(date).toLocaleDateString(); }
            catch { return String(date); }
        };
        
        const formatCurrency = (amount, currency = 'USD') => {
            try {
                return new Intl.NumberFormat('en-US', {
                    style: 'currency', currency: currency
                }).format(amount);
            } catch { return \`\${currency} \${amount}\`; }
        };
        
        // Dynamic mock generation based on imports
        ${mockGenerators.mockCode}
        
        // Mock router hooks
        const useNavigate = () => (path) => console.log('Navigate to:', path);
        const useParams = () => ({ id: '1' });
        const useLocation = () => ({ pathname: '/', search: '', hash: '' });
        const useHistory = () => ({ push: (path) => console.log('History push:', path) });
        
        // Mock Link component
        const Link = ({ to, children, className, ...props }) => 
            React.createElement('a', { 
                href: to, className,
                onClick: (e) => { e.preventDefault(); console.log('Navigate to:', to); },
                ...props 
            }, children);
        
        // Mock framer-motion components
        const motion = {
            div: ({ children, animate, initial, transition, whileHover, ...props }) => 
                React.createElement('div', props, children),
            button: ({ children, animate, initial, transition, whileHover, whileTap, ...props }) => 
                React.createElement('button', props, children),
            span: ({ children, animate, initial, transition, ...props }) => 
                React.createElement('span', props, children),
            img: ({ children, animate, initial, transition, ...props }) => 
                React.createElement('img', props, children),
        };
        
        try {
            // Your component code
            ${cleanedCode}
            
            // Auto-render the component
            const container = document.getElementById('root');
            const componentToRender = window.${componentName} || ${componentName};
            
            if (container && typeof componentToRender !== 'undefined') {
                const root = ReactDOM.createRoot(container);
                root.render(React.createElement(componentToRender));
            } else {
                const availableComponents = Object.keys(window)
                    .filter(key => typeof window[key] === 'function' && key[0] === key[0].toUpperCase())
                    .join(', ');
                container.innerHTML = \`<div class="error">
                    Component "${componentName}" not found.<br>
                    Available components: \${availableComponents || 'None'}
                </div>\`;
            }
            
        } catch (error) {
            console.error('Component render error:', error);
            const container = document.getElementById('root');
            container.innerHTML = \`
                <div class="error">
                    <h3>Error loading component:</h3>
                    <p>\${error.message}</p>
                    <details style="margin-top: 10px;">
                        <summary style="cursor: pointer; font-weight: bold;">Stack Trace</summary>
                        <pre style="margin-top: 10px; font-size: 12px; overflow: auto;">\${error.stack}</pre>
                    </details>
                </div>
            \`;
        }
    </script>
</body>
</html>`;
}

function generateMocks(imports) {
  const mockCode = [];
  const processedModules = new Set();

  // React built-in APIs that should not be mocked
  const reactBuiltins = new Set([
    'useState',
    'useEffect',
    'useContext',
    'useReducer',
    'useCallback',
    'useMemo',
    'useRef',
    'useImperativeHandle',
    'useLayoutEffect',
    'useDebugValue',
    'Component',
    'PureComponent',
    'Fragment',
    'StrictMode',
    'Suspense',
    'createElement',
    'cloneElement',
    'isValidElement',
    'Children',
    'forwardRef',
    'memo',
    'lazy',
    'createContext',
    'createRef',
  ]);

  for (const importItem of imports) {
    const { module, default: defaultImport, named, namespace } = importItem;

    if (processedModules.has(module)) continue;
    processedModules.add(module);

    // Skip React imports entirely
    if (module === 'react' || module === 'react-dom') {
      continue;
    }

    // Generate mocks based on common libraries
    if (
      module.includes('lucide-react') ||
      module === 'react-icons' ||
      module.includes('heroicons')
    ) {
      // Icon libraries
      const iconNames = named.length > 0 ? named : ['Plus', 'Minus', 'Edit', 'Trash2', 'X', 'Check', 'Arrow'];

      for (const iconName of iconNames) {
        if (!reactBuiltins.has(iconName)) {
          mockCode.push(generateIconMock(iconName));
        }
      }
    } else if (module.includes('framer-motion')) {
      // Framer Motion
      mockCode.push(`const motion = {
          div: ({ children, animate, initial, transition, whileHover, whileTap, drag, ...props }) => 
            React.createElement('div', props, children),
          button: ({ children, animate, initial, transition, whileHover, whileTap, drag, ...props }) => 
            React.createElement('button', props, children),
          span: ({ children, animate, initial, transition, whileHover, whileTap, drag, ...props }) => 
            React.createElement('span', props, children),
          img: ({ children, animate, initial, transition, whileHover, whileTap, drag, ...props }) => 
            React.createElement('img', props, children),
          form: ({ children, animate, initial, transition, whileHover, whileTap, drag, ...props }) => 
            React.createElement('form', props, children),
        };
        const AnimatePresence = ({ children, mode, ...props }) => 
          React.createElement(React.Fragment, null, children);
      `);
    } else if (module.includes('router')) {
      // Router libraries
      mockCode.push(`
        const useNavigate = () => (path) => console.log('Navigate:', path);
        const useParams = () => ({ id: '1' });
        const useLocation = () => ({ pathname: '/', search: '', hash: '' });
        const useSearchParams = () => [new URLSearchParams(), () => {}];
        const Link = ({ to, children, className, ...props }) => 
          React.createElement('a', { 
            href: to, 
            className,
            onClick: e => { e.preventDefault(); console.log('Navigate to:', to); }, 
            ...props 
          }, children);
        const NavLink = ({ to, children, className, ...props }) => 
          React.createElement('a', { 
            href: to, 
            className,
            onClick: e => { e.preventDefault(); console.log('Navigate to:', to); }, 
            ...props 
          }, children);
      `);
    } else if (module.includes('axios') || module === 'fetch') {
      // HTTP libraries
      mockCode.push(`
        const axios = {
          get: (url) => Promise.resolve({ data: { message: 'Mock GET data', url } }),
          post: (url, data) => Promise.resolve({ data: { success: true, url, data } }),
          put: (url, data) => Promise.resolve({ data: { success: true, url, data } }),
          delete: (url) => Promise.resolve({ data: { success: true, url } }),
          patch: (url, data) => Promise.resolve({ data: { success: true, url, data } })
        };
      `);
    } else if (
      module.includes('date-fns') ||
      module.includes('moment') ||
      module.includes('dayjs')
    ) {
      // Date libraries
      const dateFunctions = named.length > 0 ? named : ['format', 'parseISO', 'isValid', 'addDays', 'subDays'];
      for (const funcName of dateFunctions) {
        if (!reactBuiltins.has(funcName)) {
          mockCode.push(generateDateMock(funcName));
        }
      }
    } else if (module.includes('lodash') || module === '_') {
      // Lodash
      const lodashFunctions = named.length > 0 ? named : ['debounce', 'throttle', 'isEmpty', 'cloneDeep', 'merge'];
      for (const funcName of lodashFunctions) {
        if (!reactBuiltins.has(funcName)) {
          mockCode.push(generateLodashMock(funcName));
        }
      }
    } else if (
      module.includes('chart') ||
      module.includes('graph') ||
      module.includes('recharts')
    ) {
      // Chart libraries
      const chartComponents = named.length > 0 ? named : ['Chart', 'LineChart', 'BarChart', 'PieChart'];
      for (const componentName of chartComponents) {
        if (!reactBuiltins.has(componentName)) {
          mockCode.push(`
            const ${componentName} = ({ children, data, width = 400, height = 300, ...props }) => 
              React.createElement('div', { 
                ...props, 
                style: { 
                  width: width + 'px', 
                  height: height + 'px', 
                  background: '#f3f4f6', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  border: '1px dashed #d1d5db',
                  borderRadius: '4px'
                }
              }, \`\${componentName} (Mock)\`);
          `);
        }
      }
    } else if (module.includes('ui') || module.includes('components')) {
      // UI Component libraries (like shadcn/ui, chakra-ui, etc.)
      if (defaultImport && !reactBuiltins.has(defaultImport)) {
        mockCode.push(`
          const ${defaultImport} = ({ children, ...props }) => 
            React.createElement('div', { className: 'mock-component', ...props }, children || '${defaultImport}');
        `);
      }
      
      for (const namedImport of named) {
        if (!reactBuiltins.has(namedImport)) {
          if (namedImport.endsWith('Icon') || namedImport.includes('Icon')) {
            mockCode.push(generateIconMock(namedImport));
          } else {
            mockCode.push(`
              const ${namedImport} = ({ children, ...props }) => 
                React.createElement('div', { className: 'mock-${namedImport.toLowerCase()}', ...props }, children || '${namedImport}');
            `);
          }
        }
      }
    } else {
      // Generic mock for unknown modules
      if (defaultImport && !reactBuiltins.has(defaultImport)) {
        mockCode.push(`
          const ${defaultImport} = ({ children, ...props }) => 
            React.createElement('div', { className: 'mock-component', ...props }, children || '${defaultImport}');
        `);
      }
      
      for (const namedImport of named) {
        if (!reactBuiltins.has(namedImport)) {
          if (namedImport.endsWith('Icon') || namedImport.includes('Icon')) {
            mockCode.push(generateIconMock(namedImport));
          } else {
            mockCode.push(`
              const ${namedImport} = ({ children, ...props }) => 
                React.createElement('div', { className: 'mock-${namedImport.toLowerCase()}', ...props }, children || '${namedImport}');
            `);
          }
        }
      }
    }
  }

  return {
    mockCode: mockCode.join('\n'),
    processedModules: Array.from(processedModules)
  };
}

function generateDateMock(funcName) {
  const dateMocks = {
    format: `const format = (date, formatStr = 'MM/dd/yyyy') => {
      try { return new Date(date).toLocaleDateString(); }
      catch { return String(date); }
    };`,
    parseISO: `const parseISO = (dateStr) => {
      try { return new Date(dateStr); }
      catch { return new Date(); }
    };`,
    isValid: `const isValid = (date) => {
      try { return !isNaN(new Date(date).getTime()); }
      catch { return false; }
    };`,
    addDays: `const addDays = (date, days) => {
      const result = new Date(date);
      result.setDate(result.getDate() + days);
      return result;
    };`,
    subDays: `const subDays = (date, days) => {
      const result = new Date(date);
      result.setDate(result.getDate() - days);
      return result;
    };`,
    startOfDay: `const startOfDay = (date) => {
      const result = new Date(date);
      result.setHours(0, 0, 0, 0);
      return result;
    };`,
    endOfDay: `const endOfDay = (date) => {
      const result = new Date(date);
      result.setHours(23, 59, 59, 999);
      return result;
    };`,
  };

  return dateMocks[funcName] || `const ${funcName} = (date, ...args) => new Date(date);`;
}

// Keep the existing generateIconMock and generateLodashMock functions as they were

function generateIconMock(iconName) {
  const iconMap = {
    Plus: 'M12 5v14M5 12h14',
    Minus: 'M5 12h14',
    X: 'M18 6L6 18M6 6l12 12',
    Check: 'M20 6L9 17l-5-5',
    Edit: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
    Trash2:
      'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
    ChevronDown: 'M6 9l6 6 6-6',
    ChevronUp: 'M18 15l-6-6-6 6',
    ChevronLeft: 'M15 18l-6-6 6-6',
    ChevronRight: 'M9 18l6-6-6-6',
    Search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    Home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    User: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 3a4 4 0 100 8 4 4 0 000-8z',
    Settings:
      'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
  };

  const defaultPath = iconMap[iconName] || 'M12 2L2 7v10c0 5.55 3.84 10 9 11 5.16-1 9-5.45 9-11V7l-10-5z';

  return `
    const ${iconName} = ({ className, size = 16, ...props }) => 
      React.createElement('svg', {
        className,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...props
      }, React.createElement('path', { d: '${defaultPath}' }));
  `;
}

function generateLodashMock(funcName) {
  const lodashMocks = {
    debounce: `const debounce = (func, wait) => { let timeout; return (...args) => { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); }; };`,
    throttle: `const throttle = (func, wait) => { let timeout; return (...args) => { if (!timeout) { timeout = setTimeout(() => timeout = null, wait); return func.apply(this, args); } }; };`,
    isEmpty: `const isEmpty = (value) => !value || (typeof value === 'object' && Object.keys(value).length === 0);`,
    cloneDeep: `const cloneDeep = (obj) => JSON.parse(JSON.stringify(obj));`,
    merge: `const merge = (target, ...sources) => Object.assign(target, ...sources);`,
    get: `const get = (obj, path, defaultValue) => { const keys = path.split('.'); let result = obj; for (const key of keys) { if (result?.[key] !== undefined) result = result[key]; else return defaultValue; } return result; };`,
    set: `const set = (obj, path, value) => { const keys = path.split('.'); let current = obj; for (let i = 0; i < keys.length - 1; i++) { if (!current[keys[i]]) current[keys[i]] = {}; current = current[keys[i]]; } current[keys[keys.length - 1]] = value; return obj; };`,
  };

  return lodashMocks[funcName] || `const ${funcName} = (...args) => args[0];`;
}
