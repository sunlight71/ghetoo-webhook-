export default function Home() {
  return (
    <main style={{ 
      display: 'flex', 
      flexDirection: 'column',
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100vh',
      fontFamily: 'system-ui, sans-serif',
      background: '#0a0a0a',
      color: '#fff'
    }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>💰 Deposit Webhook</h1>
      <p style={{ color: '#888' }}>Tatum deposit notifications handler</p>
      <div style={{ 
        marginTop: '2rem', 
        padding: '1rem 2rem', 
        background: '#1a1a1a', 
        borderRadius: '8px',
        fontSize: '0.9rem'
      }}>
        <p>✅ Webhook endpoint: <code>/api/tatum</code></p>
      </div>
    </main>
  );
}
