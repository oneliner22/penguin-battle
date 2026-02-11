$ErrorActionPreference = "Stop"

$BUCKET = "public-tmp-yeah"
$STACK_NAME = "penguin-battle-pvp"
$WAF_STACK_NAME = "penguin-battle-waf"
$REGION = "ap-northeast-1"
$WAF_REGION = "us-east-1"
$CODE_KEY = "penguin-battle/lambda-code.zip"

Write-Host "=== Packaging Lambda code ===" -ForegroundColor Cyan
$zipPath = Join-Path $PSScriptRoot "lambda-code.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
Compress-Archive -Path (Join-Path $PSScriptRoot "src") -DestinationPath $zipPath

Write-Host "=== Uploading to S3 ===" -ForegroundColor Cyan
aws s3 cp $zipPath "s3://${BUCKET}/${CODE_KEY}" --region $REGION

Write-Host "=== Step 1: Deploy main stack (ap-northeast-1) ===" -ForegroundColor Cyan
aws cloudformation deploy `
  --template-file (Join-Path $PSScriptRoot "template.yaml") `
  --stack-name $STACK_NAME `
  --region $REGION `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides "CodeBucket=${BUCKET}" "CodeKey=${CODE_KEY}" "WAFIPSetId=" "WAFIPSetName="

Write-Host "=== Getting API Gateway domain ===" -ForegroundColor Cyan
$apiDomain = aws cloudformation describe-stacks `
  --stack-name $STACK_NAME `
  --region $REGION `
  --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayDomain'].OutputValue" `
  --output text

Write-Host "API Gateway Domain: $apiDomain" -ForegroundColor Green

Write-Host "=== Step 2: Deploy WAF stack (us-east-1) ===" -ForegroundColor Cyan
Write-Host "Note: CloudFront creation takes 15-30 minutes on first deploy" -ForegroundColor Yellow
aws cloudformation deploy `
  --template-file (Join-Path $PSScriptRoot "template-waf.yaml") `
  --stack-name $WAF_STACK_NAME `
  --region $WAF_REGION `
  --parameter-overrides "ApiGatewayDomain=${apiDomain}"

Write-Host "=== Getting WAF outputs ===" -ForegroundColor Cyan
$ipSetId = aws cloudformation describe-stacks `
  --stack-name $WAF_STACK_NAME `
  --region $WAF_REGION `
  --query "Stacks[0].Outputs[?OutputKey=='IPSetId'].OutputValue" `
  --output text

$ipSetName = aws cloudformation describe-stacks `
  --stack-name $WAF_STACK_NAME `
  --region $WAF_REGION `
  --query "Stacks[0].Outputs[?OutputKey=='IPSetName'].OutputValue" `
  --output text

$cfDomain = aws cloudformation describe-stacks `
  --stack-name $WAF_STACK_NAME `
  --region $WAF_REGION `
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" `
  --output text

Write-Host "IPSet ID: $ipSetId" -ForegroundColor Green
Write-Host "IPSet Name: $ipSetName" -ForegroundColor Green
Write-Host "CloudFront Domain: $cfDomain" -ForegroundColor Green

Write-Host "=== Step 3: Update main stack with WAF config ===" -ForegroundColor Cyan
aws cloudformation deploy `
  --template-file (Join-Path $PSScriptRoot "template.yaml") `
  --stack-name $STACK_NAME `
  --region $REGION `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides "CodeBucket=${BUCKET}" "CodeKey=${CODE_KEY}" "WAFIPSetId=${ipSetId}" "WAFIPSetName=${ipSetName}"

Write-Host "=== Updating Lambda function code ===" -ForegroundColor Cyan
aws lambda update-function-code --function-name PenguinBattle-Connect --s3-bucket $BUCKET --s3-key $CODE_KEY --region $REGION --output text --query 'LastModified'
aws lambda update-function-code --function-name PenguinBattle-Message --s3-bucket $BUCKET --s3-key $CODE_KEY --region $REGION --output text --query 'LastModified'
aws lambda update-function-code --function-name PenguinBattle-Disconnect --s3-bucket $BUCKET --s3-key $CODE_KEY --region $REGION --output text --query 'LastModified'
aws lambda update-function-code --function-name PenguinBattle-WafSync --s3-bucket $BUCKET --s3-key $CODE_KEY --region $REGION --output text --query 'LastModified'

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host "WebSocket URL (CloudFront): wss://${cfDomain}" -ForegroundColor Green
Write-Host "WebSocket URL (Direct):     wss://${apiDomain}/prod" -ForegroundColor Yellow
Write-Host ""
Write-Host "Update pvp/index.html WS_URL to: wss://${cfDomain}" -ForegroundColor Yellow

# Clean up
Remove-Item $zipPath
