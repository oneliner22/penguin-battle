$ErrorActionPreference = "Stop"

$BUCKET = "public-tmp-yeah"
$STACK_NAME = "penguin-battle-pvp"
$REGION = "ap-northeast-1"
$CODE_KEY = "penguin-battle/lambda-code.zip"

Write-Host "=== Packaging Lambda code ===" -ForegroundColor Cyan
# Create zip of src/ directory
$zipPath = Join-Path $PSScriptRoot "lambda-code.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path (Join-Path $PSScriptRoot "src") -DestinationPath $zipPath

Write-Host "=== Uploading to S3 ===" -ForegroundColor Cyan
aws s3 cp $zipPath "s3://${BUCKET}/${CODE_KEY}" --region $REGION

Write-Host "=== Deploying CloudFormation stack ===" -ForegroundColor Cyan
aws cloudformation deploy `
  --template-file (Join-Path $PSScriptRoot "template.yaml") `
  --stack-name $STACK_NAME `
  --region $REGION `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides "CodeBucket=${BUCKET}" "CodeKey=${CODE_KEY}"

Write-Host "=== Getting WebSocket URL ===" -ForegroundColor Cyan
$wsUrl = aws cloudformation describe-stacks `
  --stack-name $STACK_NAME `
  --region $REGION `
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketURL'].OutputValue" `
  --output text

Write-Host ""
Write-Host "WebSocket URL: $wsUrl" -ForegroundColor Green
Write-Host ""
Write-Host "Update pvp/index.html with this URL" -ForegroundColor Yellow

# Clean up
Remove-Item $zipPath
