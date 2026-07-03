use clap::Parser;
use core_engine::args::EngineArgs;
use core_engine::run_download;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = EngineArgs::parse();
    run_download(args).await
}
