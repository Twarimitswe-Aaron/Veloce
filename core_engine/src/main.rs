use clap::Parser;
use core_engine::args::EngineArgs;
use core_engine::run_download;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = EngineArgs::parse().normalize();

    if !args.quiet {
        eprintln!("━━━ Veloce Engine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        eprintln!(" 🔗 URL:       {}", args.url);
        eprintln!(" 💾 Save path: {}", args.save_path);
        eprintln!(" 🧵 Threads:   {} (ceiling, max 64)", args.threads);
        if args.max_rate > 0 {
            eprintln!(" 🔒 Rate cap:  {} B/s", args.max_rate);
        }
        if let Some(ref r) = args.referer {
            eprintln!(" 🔗 Referer:   {}", r);
        }
        if let Some(ref o) = args.origin {
            eprintln!(" 🌐 Origin:    {}", o);
        }
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }

    run_download(args).await
}
