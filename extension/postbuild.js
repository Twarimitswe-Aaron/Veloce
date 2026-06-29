import fs from 'fs';
import path from 'path';

const buildDir = './build';

function extractInlineScripts(htmlFilePath) {
    let html = fs.readFileSync(htmlFilePath, 'utf8');
    
    let scriptCounter = 0;
    
    // Regex to match inline scripts. We avoid matching scripts that have a 'src' attribute.
    html = html.replace(/<script(?![^>]*src=)(.*?)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
        scriptCounter++;
        const filename = path.basename(htmlFilePath, '.html');
        const scriptName = `${filename}-init-${scriptCounter}.js`;
        
        // SvelteKit uses document.currentScript.parentElement. 
        // We replace it with document.querySelector('body > div') because document.currentScript is null for ES modules.
        let modifiedContent = content.replace(
            'document.currentScript.parentElement',
            "document.querySelector('body > div')"
        );
        
        // In strict mode (which type="module" implies), assigning to undeclared variables throws ReferenceError.
        // SvelteKit assigns to __sveltekit_xxx without declaring it, so we prefix it with window.
        modifiedContent = modifiedContent.replace(/(__sveltekit_[a-zA-Z0-9_]+)\s*=/g, 'window.$1 =');
        
        fs.writeFileSync(path.join(buildDir, scriptName), modifiedContent);
        
        // Return external script tag
        return `<script type="module" src="/${scriptName}"></script>`;
    });

    // Remove all <link rel="modulepreload"> tags which trigger CSP violations in Chrome MV3
    html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>/gi, '');

    fs.writeFileSync(htmlFilePath, html);
    console.log(`Extracted inline scripts and removed modulepreloads from ${htmlFilePath}`);
}

const files = fs.readdirSync(buildDir);
for (const file of files) {
    if (file.endsWith('.html')) {
        extractInlineScripts(path.join(buildDir, file));
    }
}
