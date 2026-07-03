use clap::Parser;

/// Veloce high-performance download engine
#[derive(Parser, Debug, Clone)]
#[command(author, version, about)]
pub struct EngineArgs {
    #[arg(long)]
    pub id: String,

    #[arg(long)]
    pub url: String,

    #[arg(long)]
    pub save_path: String,

    /// Maximum parallel connections (ceiling for auto-tune).
    #[arg(long, default_value_t = 8)]
    pub threads: u64,

    /// Global speed cap in bytes/sec (0 = unlimited).
    #[arg(long, default_value_t = 0)]
    pub max_rate: u64,

    #[arg(long, default_value_t = false)]
    pub quiet: bool,

    #[arg(long)]
    pub referer: Option<String>,

    #[arg(long)]
    pub origin: Option<String>,

    /// Piece size in bytes (0 = auto from file size / host profile).
    #[arg(long, default_value_t = 0)]
    pub piece_size_bytes: u64,

    /// HTTP read buffer per connection in bytes.
    #[arg(long, default_value_t = 262_144)]
    pub read_buffer_bytes: usize,

    /// Probe throughput and pick optimal connection count (disabled with --no-auto-tune).
    #[arg(long, default_value_t = true)]
    pub auto_tune: bool,

    /// Disable auto-tune probe.
    #[arg(long)]
    pub no_auto_tune: bool,

    /// Disable staggered worker startup (all connections at once).
    #[arg(long, default_value_t = false)]
    pub no_stagger: bool,

    /// Optional JSON host profile file path.
    #[arg(long)]
    pub profiles_path: Option<String>,
}
