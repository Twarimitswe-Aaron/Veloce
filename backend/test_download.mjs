import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:14921/ws');

ws.on('open', () => {
    console.log('Connected. Requesting download...');
    ws.send(JSON.stringify({
        type: 'NEW_DOWNLOAD',
        payload: {
            url: 'https://ash-speed.hetzner.com/100MB.bin',
            fileName: 'hetzner_100MB.bin'
        }
    }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'DOWNLOAD_COMPLETE' || (msg.type === 'DOWNLOAD_STATUS' && msg.status === 'error') || msg.type === 'DOWNLOAD_ERROR') {
        console.log('Finished. Closing connection.');
        ws.close();
    }
});
